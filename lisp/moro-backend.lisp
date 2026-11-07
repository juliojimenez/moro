;;;; moro-backend.lisp -- introspection server loaded into the REPL image by moro,
;;;; the Common Lisp extension for Visual Studio Code.
;;;;
;;;; (moro-backend:start port token-file) listens on 127.0.0.1:PORT in a
;;;; background thread. A client sends the contents of TOKEN-FILE as its first
;;;; line, then one request form after another (a request may span lines, as
;;;; the text of an :eval usually does); every request gets one response form.
;;;; Introspection requests (:arglist :documentation :complete :packages
;;;; :definition) are read with *READ-EVAL* bound to NIL and never evaluated.
;;;; :eval and :inspect evaluate code the editor sends, as the REPL would, with
;;;; output and return values captured. An error either comes back with a
;;;; backtrace, or, when the :eval asked for the debugger, opens a debugger loop
;;;; on the evaluation thread: the client receives a (:debug ...) event with the
;;;; restarts and frames and answers with :invoke-restart, :frame-locals,
;;;; :inspect-local, :inspect-condition or :abort until control transfers.
;;;; :interrupt stops a running evaluation. Every connection runs in its own
;;;; thread, so an evaluation never blocks completion.
;;;;
;;;; Supported: SBCL and ECL (sb-bsd-sockets), Clozure CL (ccl:make-socket),
;;;; ABCL (java.net). CLISP has no threads; START returns NIL there.

(defpackage #:moro-backend
  (:use #:cl)
  (:export #:start #:stop #:*port*))

(in-package #:moro-backend)

#+sbcl (eval-when (:compile-toplevel :load-toplevel :execute) (require :sb-bsd-sockets) (require :sb-introspect))
#+ecl (eval-when (:compile-toplevel :load-toplevel :execute) (require :sockets))

(defvar *port* nil "Port the backend listens on, or NIL when it is not running.")
(defvar *server* nil)
(defvar *thread* nil)
(defvar *token* nil)
(defvar *eval-thread* nil "The thread running an :eval or :inspect request, while one does.")
(defvar *client-stream* nil "The stream of the connection being served, for debugger events.")
(defvar *debugger-level* 0 "How many debugger loops are active on this thread.")
(defvar *outer-restarts* '() "The restarts that already existed when the evaluation started; never offered.")
(defvar *debugger-abort* nil "While a debugger loop runs on this thread, the function that abandons its evaluation.")
(defvar *inspector-stack* '() "Objects being inspected, innermost first, each as (object . parts).")
(defconstant +inspector-limit+ 200 "Elements shown of a sequence or hash table.")

;;; ------------------------------------------------------------------ threads

(defun spawn (name function)
  #+sbcl (sb-thread:make-thread function :name name)
  #+ecl (mp:process-run-function name function)
  #+ccl (ccl:process-run-function name function)
  #+abcl (threads:make-thread function :name name)
  #-(or sbcl ecl ccl abcl) (progn name function nil))

(defun current-thread ()
  #+sbcl sb-thread:*current-thread*
  #+ecl mp:*current-process*
  #+ccl ccl:*current-process*
  #+abcl (threads:current-thread)
  #-(or sbcl ecl ccl abcl) nil)

(defun interrupt-thread (thread function)
  #+sbcl (sb-thread:interrupt-thread thread function)
  #+ecl (mp:interrupt-process thread function)
  #+ccl (ccl:process-interrupt thread function)
  #+abcl (threads:interrupt-thread thread function)
  #-(or sbcl ecl ccl abcl) (progn thread function nil))

;;; ------------------------------------------------------------------ sockets

(defun make-server (port)
  "A listening loopback socket on PORT."
  #+(or sbcl ecl)
  (let ((socket (make-instance 'sb-bsd-sockets:inet-socket :type :stream :protocol :tcp)))
    (setf (sb-bsd-sockets:sockopt-reuse-address socket) t)
    (sb-bsd-sockets:socket-bind socket #(127 0 0 1) port)
    (sb-bsd-sockets:socket-listen socket 5)
    socket)
  #+ccl
  (ccl:make-socket :connect :passive :local-host "127.0.0.1" :local-port port :reuse-address t)
  #+abcl
  (java:jnew "java.net.ServerSocket" port 5 (java:jstatic "getByName" "java.net.InetAddress" "127.0.0.1"))
  #-(or sbcl ecl ccl abcl)
  (progn port nil))

(defun accept-client (server)
  "Blocks until a client connects; returns a bidirectional character stream."
  #+(or sbcl ecl)
  (let ((client (sb-bsd-sockets:socket-accept server)))
    (sb-bsd-sockets:socket-make-stream client :input t :output t :element-type 'character
                                              :external-format :utf-8 :buffering :full))
  #+ccl
  (ccl:accept-connection server :wait t)
  #+abcl
  (let ((socket (java:jcall "accept" server)))
    (ext:get-socket-stream socket :element-type 'character :external-format :utf-8))
  #-(or sbcl ecl ccl abcl)
  (progn server nil))

(defun close-server (server)
  #+(or sbcl ecl) (sb-bsd-sockets:socket-close server)
  #+ccl (close server)
  #+abcl (java:jcall "close" server)
  #-(or sbcl ecl ccl abcl) server)

;;; ------------------------------------------------------------------ reading and printing

(defun strip-packages (x)
  "Replace symbols foreign to CL with uninterned copies so arglists print without package prefixes."
  (cond ((null x) nil)
        ((symbolp x) (if (or (keywordp x) (eq (symbol-package x) (find-package :cl))) x (make-symbol (symbol-name x))))
        ((consp x) (cons (strip-packages (car x)) (strip-packages (cdr x))))
        (t x)))

(defun plain-keys (lambda-list)
  "LAMBDA-LIST with its keyword parameters written as plain names: CCL reports (a &key :b)."
  (if (and (listp lambda-list) (null (cdr (last lambda-list))))
      (let ((keys nil))
        (mapcar (lambda (item)
                  (cond ((member item lambda-list-keywords) (setf keys (eq item '&key)) item)
                        ((and keys (keywordp item)) (make-symbol (symbol-name item)))
                        ((and keys (consp item) (keywordp (first item))) (cons (make-symbol (symbol-name (first item))) (rest item)))
                        (t item)))
                lambda-list))
      lambda-list))

(defun render (object)
  (let ((*print-case* :downcase) (*print-gensym* nil) (*print-pretty* nil) (*print-readably* nil)
        (*print-length* nil) (*print-level* nil) (*print-circle* nil)
        (*package* (find-package :cl)))
    (prin1-to-string (strip-packages object))))

(defun write-response (response stream)
  (let ((*print-readably* nil) (*print-pretty* nil) (*print-circle* nil) (*print-length* nil)
        (*print-level* nil) (*print-case* :upcase) (*print-escape* t)
        (*package* (find-package :moro-backend)))
    (prin1 response stream)
    (terpri stream)
    (finish-output stream)))

;;; ------------------------------------------------------------------ symbols

(defun find-package* (designator)
  (and designator (find-package (string-upcase (string designator)))))

(defun resolve (name package-name)
  "The symbol named NAME (already upper-cased by the client) accessible in PACKAGE-NAME, else in CL-USER, else NIL."
  (or (let ((package (find-package* package-name)))
        (and package (find-symbol name package)))
      (find-symbol name (find-package :cl-user))
      (let ((colon (position #\: name)))
        (and colon
             (let ((package (find-package* (subseq name 0 colon))))
               (and package (find-symbol (string-left-trim ":" (subseq name colon)) package)))))))

(defun arglist (symbol)
  "The lambda list of SYMBOL's function or macro, or :UNKNOWN."
  (handler-case
      (cond ((macro-function symbol)
             #+sbcl (sb-introspect:function-lambda-list (macro-function symbol))
             #+ccl (plain-keys (ccl:arglist (macro-function symbol)))
             #+ecl (ext:function-lambda-list (macro-function symbol))
             #+abcl (values (ext:arglist (macro-function symbol)))
             #-(or sbcl ccl ecl abcl) :unknown)
            ((special-operator-p symbol)
             #+sbcl (sb-introspect:function-lambda-list symbol)
             #-sbcl :unknown)
            ((fboundp symbol)
             #+sbcl (sb-introspect:function-lambda-list symbol)
             #+ccl (plain-keys (ccl:arglist symbol))
             #+ecl (ext:function-lambda-list symbol)
             #+abcl (values (ext:arglist symbol))
             #-(or sbcl ccl ecl abcl) :unknown)
            (t :unknown))
    (error () :unknown)))

(defun kinds (symbol)
  (let ((kinds '()))
    (cond ((special-operator-p symbol) (push :special-operator kinds))
          ((macro-function symbol) (push :macro kinds))
          ((fboundp symbol) (push (if (typep (fdefinition symbol) 'generic-function) :generic-function :function) kinds)))
    (when (boundp symbol) (push (if (constantp symbol) :constant :variable) kinds))
    (when (find-class symbol nil) (push :class kinds))
    (nreverse kinds)))

(defun doc (symbol kind)
  (handler-case (documentation symbol kind) (error () nil)))

(defun symbol-documentation (symbol)
  (let ((docs '()))
    (flet ((add (kind text) (when text (push (list kind text) docs))))
      (when (or (fboundp symbol) (special-operator-p symbol)) (add :function (doc symbol 'function)))
      (when (boundp symbol) (add :variable (doc symbol 'variable)))
      (when (find-class symbol nil) (add :type (or (doc symbol 'type) (doc symbol 'structure)))))
    (nreverse docs)))

(defun print-name (symbol package)
  "SYMBOL's name as the client should insert it when PACKAGE is current."
  (let ((*print-case* :downcase) (*print-readably* nil) (*print-escape* t)
        (*package* (or package (find-package :cl-user))))
    (let ((text (prin1-to-string symbol)))
      ;; Only the name part: the client re-attaches whatever prefix was typed.
      (let ((colon (position #\: text :from-end t)))
        (if (and colon (not (char= (char text 0) #\|))) (subseq text (1+ colon)) text)))))

(defun completions (prefix package-name &key (limit 200))
  "Symbols accessible in PACKAGE-NAME (or external in PKG for a PKG:PREFIX) starting with PREFIX."
  (let* ((colon (position #\: prefix))
         (external-only (and colon (not (and (< (1+ colon) (length prefix)) (char= (char prefix (1+ colon)) #\:)))))
         (target (if colon (find-package* (subseq prefix 0 colon)) (find-package* package-name)))
         (needle (string-upcase (if colon (string-left-trim ":" (subseq prefix colon)) prefix)))
         (results '()))
    (when (and (null colon) (null target)) (setf target (find-package :cl-user)))
    (when target
      (flet ((consider (symbol)
               (let ((name (symbol-name symbol)))
                 (when (and (>= (length name) (length needle))
                            (string= needle name :end2 (length needle)))
                   (pushnew symbol results)))))
        (if colon
            (if external-only
                (do-external-symbols (symbol target) (consider symbol))
                (do-symbols (symbol target) (consider symbol)))
            (do-symbols (symbol target) (consider symbol)))))
    (setf results (sort results #'string< :key #'symbol-name))
    (when (> (length results) limit) (setf results (subseq results 0 limit)))
    (loop for symbol in results
          collect (list (print-name symbol target)
                        (or (first (kinds symbol)) :symbol)
                        (let ((package (symbol-package symbol))) (if package (package-name package) ""))))))

(defparameter *definer-types*
  '((:function "DEFUN" "FUNCTION") (:macro "DEFMACRO" "MACRO") (:variable "DEFVAR" "DEFPARAMETER" "VARIABLE")
    (:constant "DEFCONSTANT" "CONSTANT") (:class "DEFCLASS" "CLASS") (:generic-function "DEFGENERIC" "GENERIC-FUNCTION")
    (:method "DEFMETHOD" "METHOD") (:structure "DEFSTRUCT" "STRUCTURE") (:type "DEFTYPE" "TYPE")
    (:condition "DEFINE-CONDITION" "CONDITION") (:setf-expander "DEFSETF" "DEFINE-SETF-EXPANDER" "SETF-EXPANDER")
    (:compiler-macro "DEFINE-COMPILER-MACRO" "COMPILER-MACRO"))
  "Definition :type keywords and the names implementations use for them.")

(defun definer-type (designator)
  "The :type keyword for what an implementation calls a definition: a definer
   symbol (DEFUN), a kind symbol (FUNCTION, :METHOD) or a list headed by one."
  (let ((name (handler-case (string (if (consp designator) (first designator) designator)) (error () ""))))
    (or (first (find-if (lambda (entry) (member name (rest entry) :test #'string=)) *definer-types*))
        :function)))

(defun source-file (designator)
  "DESIGNATOR as a namestring when it names a file, else NIL."
  (and (or (pathnamep designator) (stringp designator))
       (handler-case (namestring (translate-logical-pathname designator)) (error () (namestring designator)))))

(defun definition-sources (symbol)
  "Source locations of SYMBOL's definitions, each a plist with :file, :type and
   one of :offset (the character offset of the form; SBCL, CCL), :after (a
   file position at or before the form, where the reader stood when it was
   about to read it; ECL, ABCL) or :form (the index of the top-level form)."
  #+sbcl
  (let ((out '()))
    (dolist (type '(:function :macro :generic-function :method :variable :constant :class :condition :structure :type :setf-expander :compiler-macro))
      (dolist (source (handler-case (sb-introspect:find-definition-sources-by-name symbol type) (error () nil)))
        (let ((file (source-file (sb-introspect:definition-source-pathname source))))
          (when file
            (let ((offset (sb-introspect:definition-source-character-offset source))
                  (path (sb-introspect:definition-source-form-path source)))
              (pushnew (list :file file (if offset :offset :form) (or offset (first path) 0) :type type)
                       out :test #'equal))))))
    (nreverse out))
  #+ccl
  ;; ((definition-type . name) . source-notes); a source note knows its file and the form's start.
  (let ((out '()))
    (dolist (entry (handler-case (ccl:find-definition-sources symbol) (error () nil)))
      (let* ((type (handler-case (definer-type (ccl:definition-type-name (first (first entry)))) (error () :function)))
             (type (if (and (eq type :function) (macro-function symbol)) :macro type)))
        (dolist (note (rest entry))
          (let ((file (and (ccl:source-note-p note) (source-file (ccl:source-note-filename note)))))
            (when file
              (pushnew (list :file file :offset (or (ccl:source-note-start-pos note) 0) :type type)
                       out :test #'equal))))))
    (nreverse out))
  #+ecl
  ;; ((DEFUN NAME) #P"file" . position): the position is where the reader stood
  ;; before reading the form, right after the previous top-level form.
  (let ((out '()))
    (dolist (entry (handler-case (ext:get-annotation symbol 'si::location :all) (error () nil)))
      (when (and (consp entry) (consp (rest entry)))
        (let ((file (source-file (second entry)))
              (position (cddr entry)))
          (when file
            (pushnew (list :file file :after (if (integerp position) position 0) :type (definer-type (first entry)))
                     out :test #'equal)))))
    (nreverse out))
  #+abcl
  ;; ((:FUNCTION NAME) "file" position) or (:MACRO "file" position) on the SYS::SOURCE
  ;; property; the position is right after the previous top-level form and the
  ;; whitespace character that ended it. Older ABCLs keep (file . position) in SYS::%SOURCE.
  (let ((out '()))
    (dolist (entry (handler-case (get symbol 'sys::source) (error () nil)))
      (when (and (consp entry) (consp (rest entry)) (consp (cddr entry)))
        (let ((file (source-file (second entry)))
              (position (third entry)))
          (when file
            (pushnew (list :file file :after (if (integerp position) position 0) :type (definer-type (first entry)))
                     out :test #'equal)))))
    (unless out
      (let* ((source (handler-case (get symbol 'sys::%source) (error () nil)))
             (file (and (consp source) (source-file (car source)))))
        (when file
          (push (list :file file :after (if (integerp (cdr source)) (cdr source) 0) :type :function) out))))
    (nreverse out))
  #-(or sbcl ccl ecl abcl) (progn symbol nil))

(defun one-line (text)
  "TEXT with line breaks collapsed, for error messages."
  (with-output-to-string (out)
    (let ((space nil))
      (loop for ch across text
            do (if (member ch '(#\Newline #\Return #\Tab #\Space))
                   (setf space t)
                   (progn (when space (write-char #\Space out) (setf space nil))
                          (write-char ch out)))))))

(defun read-request (stream)
  "The next request form, :EOF at end of input, or (:%unreadable message) after a reader error."
  (handler-case
      (let ((*read-eval* nil) (*package* (find-package :moro-backend)))
        (read stream nil :eof))
    (end-of-file () :eof)
    (error (e)
      ;; The stream position after a reader error is anybody's guess: drop what is buffered.
      (ignore-errors (clear-input stream))
      (list :%unreadable (one-line (handler-case (princ-to-string e) (error () "unreadable request")))))))

;;; ------------------------------------------------------------------ evaluation

(defun safe-prin1 (object &optional (package (find-package :cl-user)))
  "OBJECT printed for the editor: bounded, circular-safe, never signalling."
  (handler-case
      (let ((*print-length* 100) (*print-level* 10) (*print-circle* t) (*print-readably* nil)
            (*print-pretty* t) (*print-right-margin* 100) (*package* package))
        (prin1-to-string object))
    (error () "#<unprintable>")))

(defparameter *backtrace-noise*
  '("MORO-BACKEND::" "SB-KERNEL::%SIGNAL" "SB-DEBUG::" "INVOKE-DEBUGGER" "(ERROR " "(BREAK " "(WARN " "(SIGNAL "
    "SB-KERNEL::INTERNAL-ERROR" "SB-KERNEL:INTERNAL-ERROR" "SB-KERNEL:WITH-SIMPLE-CONDITION-RESTARTS"
    "SB-INT:SIMPLE-EVAL-IN-LEXENV" "SB-IMPL::%SIMPLE-EVAL" "SB-IMPL::SIMPLE-EVAL-PROGN-BODY" "SB-EVAL::" "(EVAL "
    "SB-C::%COMPILE-IN-LEXENV" "SB-C:EVAL-WITH-COMPILE-IN-LEXENV" ":IN SB-C::" "SB-C::COMPILE-TOPLEVEL"
    "(\"top level form\")"
    ;; Clozure CL: its own error machinery and evaluator, and the backtrace call itself.
    "CCL::" "(BACKTRACE-AS-LIST" "(CCL:BACKTRACE-AS-LIST" "(FUNCALL ")
  "Frames of the signalling, evaluation and compilation machinery, and of the backend itself.")

(defun noise-frame-p (frame)
  (some (lambda (noise) (search noise frame)) *backtrace-noise*))

(defun trim-backtrace (frames)
  "FRAMES above the backend's own call, without the machinery frames."
  (let ((end (position-if (lambda (frame)
                            (or (search "(MORO-BACKEND::EVALUATE-TEXT" frame) (search "(MORO-BACKEND::INSPECT-TEXT" frame)))
                          frames :from-end t)))
    (remove-if #'noise-frame-p (subseq frames 0 (or end (length frames))))))

#+ccl
(defun ccl-frame-text (frame)
  "A CCL frame as (name args...): BACKTRACE-AS-LIST hands the arguments over already printed."
  (if (consp frame)
      (format nil "(~A~{ ~A~})" (safe-prin1 (first frame)) (mapcar (lambda (arg) (if (stringp arg) arg (safe-prin1 arg))) (rest frame)))
      (safe-prin1 frame)))

(defun capture-backtrace ()
  "A few frames of the current backtrace as strings, where the implementation offers them."
  (handler-case
      (trim-backtrace
       (mapcar (lambda (frame) (one-line #+ccl (ccl-frame-text frame) #-ccl (safe-prin1 frame)))
               #+sbcl (sb-debug:list-backtrace :count 40)
               #+ccl (let ((frames (ccl:backtrace-as-list))) (subseq frames 0 (min 40 (length frames))))
               #-(or sbcl ccl) nil))
    (error () nil)))

;;; ------------------------------------------------------------------ inspector

(defun arglist-of (function)
  (handler-case
      #+sbcl (sb-introspect:function-lambda-list function)
      #+ccl (plain-keys (ccl:arglist function))
      #+ecl (ext:function-lambda-list function)
      #+abcl (values (ext:arglist function))
      #-(or sbcl ccl ecl abcl) (progn function :unknown)
    (error () :unknown)))

(defun slot-parts (object)
  (let ((class (class-of object)))
    (loop for slot in #+sbcl (sb-mop:class-slots class) #+ccl (ccl:class-slots class)
                      #+ecl (clos:class-slots class) #+abcl (mop:class-slots class)
                      #-(or sbcl ccl ecl abcl) nil
          for name = #+sbcl (sb-mop:slot-definition-name slot) #+ccl (ccl:slot-definition-name slot)
                     #+ecl (clos:slot-definition-name slot) #+abcl (mop:slot-definition-name slot)
                     #-(or sbcl ccl ecl abcl) nil
          when name
            collect (cons (string-downcase (symbol-name name))
                          (if (slot-boundp object name) (slot-value object name) :%unbound)))))

(defun inspector-parts (object)
  "The parts of OBJECT as (label . value) pairs, in the order shown."
  (handler-case
      ;; Hash tables, packages and pathnames are structure-objects on some
      ;; implementations: their clauses must come before the generic one.
      (typecase object
        (string nil)
        (cons (if (ignore-errors (list-length object))
                  (loop for element in object for i from 0 below +inspector-limit+ collect (cons (format nil "~D" i) element))
                  (list (cons "car" (car object)) (cons "cdr" (cdr object)))))
        (vector (loop for element across object for i from 0 below +inspector-limit+ collect (cons (format nil "~D" i) element)))
        (array (list (cons "dimensions" (array-dimensions object)) (cons "element type" (array-element-type object))))
        (hash-table (let ((parts '()) (count 0))
                      (maphash (lambda (key value)
                                 (when (< count +inspector-limit+) (push (cons (safe-prin1 key) value) parts) (incf count)))
                               object)
                      (append (list (cons "count" (hash-table-count object)) (cons "test" (hash-table-test object))) (nreverse parts))))
        (symbol (list (cons "name" (symbol-name object))
                      (cons "package" (symbol-package object))
                      (cons "value" (if (boundp object) (symbol-value object) :%unbound))
                      (cons "function" (if (fboundp object) (fdefinition object) :%unbound))
                      (cons "plist" (symbol-plist object))))
        (package (list (cons "name" (package-name object)) (cons "nicknames" (package-nicknames object))
                       (cons "uses" (package-use-list object)) (cons "used by" (package-used-by-list object))))
        (function (let ((lambda-list (arglist-of object)))
                    (append (list (cons "lambda list" (if (eq lambda-list :unknown) "unknown" lambda-list)))
                            (list (cons "documentation" (or (ignore-errors (documentation object t)) ""))))))
        (pathname (list (cons "namestring" (namestring object)) (cons "directory" (pathname-directory object))
                        (cons "name" (pathname-name object)) (cons "type" (pathname-type object))))
        ((or standard-object structure-object condition) (slot-parts object))
        (t nil))
    (error () nil)))

(defun inspector-view ()
  (let ((entry (first *inspector-stack*)))
    (if (null entry)
        (list :none)
        (let ((object (car entry)) (parts (cdr entry)))
          (list :ok
                :title (safe-prin1 object)
                :type (safe-prin1 (type-of object))
                :depth (length *inspector-stack*)
                :parts (loop for (label . value) in parts
                             for index from 0
                             collect (list index label
                                           (if (eq value :%unbound) "#<unbound>" (safe-prin1 value))
                                           (and (not (eq value :%unbound)) (not (null (inspector-parts value))) t))))))))

(defun inspect-object (object)
  (push (cons object (inspector-parts object)) *inspector-stack*)
  (inspector-view))

(defun inspect-text (text package-name)
  "Evaluate TEXT like :eval and inspect its primary value."
  (let* ((package (or (find-package* package-name) (find-package :cl-user)))
         (result nil) (message nil))
    (flet ((abort-with (condition)
             (setf message (one-line (handler-case (princ-to-string condition) (error () "error"))))
             (throw 'moro-inspect-abort nil)))
      (setf *eval-thread* (current-thread))
      (unwind-protect
           (catch 'moro-inspect-abort
             (let ((*package* package)
                   (*standard-output* (make-broadcast-stream)) (*error-output* (make-broadcast-stream))
                   (*standard-input* (make-string-input-stream ""))
                   (*debugger-hook* (lambda (condition hook) (declare (ignore hook)) (abort-with condition)))
                   #+sbcl (sb-ext:*invoke-debugger-hook* (lambda (condition hook) (declare (ignore hook)) (abort-with condition))))
               (handler-bind ((error #'abort-with)
                              (warning #'muffle-warning))
                 (with-input-from-string (in text)
                   (loop for form = (read in nil in)
                         until (eq form in)
                         do (setf result (eval form)))))))
        (setf *eval-thread* nil)))
    (if message
        (list :error message)
        (progn (setf *inspector-stack* '()) (inspect-object result)))))

(defun inspect-part (index)
  (let* ((entry (first *inspector-stack*))
         (part (and entry (integerp index) (nth index (cdr entry)))))
    (cond ((null part) (list :error (format nil "no part ~A" index)))
          ((eq (cdr part) :%unbound) (list :error "the slot is unbound"))
          (t (inspect-object (cdr part))))))

(defun inspect-pop ()
  (pop *inspector-stack*)
  (inspector-view))

;;; ------------------------------------------------------------------ debugger

#+sbcl
(defun frame-text (frame)
  (handler-case
      (one-line (with-output-to-string (out)
                  (let ((*print-length* 20) (*print-level* 4) (*print-pretty* nil) (*package* (find-package :cl-user)))
                    (sb-debug::print-frame-call frame out))))
    (error () (one-line (safe-prin1 frame)))))

(defun capture-frames ()
  "The frames of this thread as (frame-object . text), innermost first, without the machinery.
   SB-DEBUG and SB-DI internals are named with two colons: they exist in every
   supported SBCL but are exported only by recent releases (2.2.9 keeps
   MAP-BACKTRACE internal)."
  #+sbcl
  (let ((frames '()))
    (handler-case (sb-debug::map-backtrace (lambda (frame) (push (cons frame (frame-text frame)) frames)) :count 80)
      (error () nil))
    (setf frames (nreverse frames))
    (let ((end (position-if (lambda (entry) (search "MORO-BACKEND::EVALUATE-TEXT" (cdr entry))) frames :from-end t)))
      (remove-if (lambda (entry) (noise-frame-p (cdr entry))) (subseq frames 0 (or end (length frames))))))
  #-sbcl
  (mapcar (lambda (text) (cons nil text)) (capture-backtrace)))

(defun frame-variables (frame)
  "The variables of FRAME as (name . value), value :%unavailable when the compiler kept no trace of it."
  #+sbcl
  (handler-case
      (let* ((debug-fun (sb-di::frame-debug-fun frame))
             (location (sb-di::frame-code-location frame))
             (vars (sb-di::debug-fun-debug-vars debug-fun)))
        (when vars
          (loop for var across vars
                collect (cons (string-downcase (symbol-name (sb-di::debug-var-symbol var)))
                              (if (eq (sb-di::debug-var-validity var location) :valid)
                                  (sb-di::debug-var-value var frame)
                                  :%unavailable)))))
    (error () nil))
  #-sbcl (progn frame nil))

(defun frame-locals (frame)
  (loop for (name . value) in (frame-variables frame)
        collect (list name (if (eq value :%unavailable) "#<not available>" (safe-prin1 value)))))

(defun debug-event (condition restarts frames)
  (list :debug
        :level *debugger-level*
        :condition (one-line (handler-case (princ-to-string condition) (error () "condition")))
        :type (safe-prin1 (type-of condition))
        :restarts (loop for restart in restarts
                        for index from 0
                        collect (list index
                                      (string (or (restart-name restart) ""))
                                      (one-line (handler-case (princ-to-string restart) (error () "")))))
        :frames (loop for (nil . text) in frames for index from 0 collect (list index text))))

(defun pick (index list)
  "The INDEXth element of LIST when INDEX is a valid index, else NIL."
  (and (integerp index) (<= 0 index) (nth index list)))

(defun read-arguments (texts package)
  "Evaluate the value forms a restart was given, in PACKAGE."
  (let ((*package* package))
    (loop for text in texts collect (eval (read-from-string (string text))))))

(defun evaluation-restarts (condition)
  "The restarts for CONDITION established by the evaluation itself, innermost first:
   those below it would unwind the connection thread or exit the image."
  (let* ((all (compute-restarts condition))
         (end (and *outer-restarts* (position (first *outer-restarts*) all))))
    (if end (subseq all 0 end) all)))

(defun debug-condition (condition stream package abort)
  "Tell the client about CONDITION, then obey its debugger commands until a
   restart transfers control (the evaluation goes on) or ABORT unwinds it."
  (let* ((*debugger-level* (1+ *debugger-level*))
         (restarts (evaluation-restarts condition))
         (frames (capture-frames))
         (*debugger-abort* (lambda () (funcall abort condition frames))))
    (write-response (debug-event condition restarts frames) stream)
    (loop
      (let ((command (read-request stream)))
        (cond
          ((eq command :eof) (funcall abort condition frames))
          ((not (consp command)) (write-response (list :debugger-error "bad command") stream))
          (t
           (handler-case
               (case (first command)
                 (:invoke-restart
                  (let ((restart (pick (second command) restarts)))
                    (if restart
                        (apply #'invoke-restart restart (read-arguments (cddr command) package))
                        (write-response (list :debugger-error "no such restart") stream))))
                 (:abort (funcall abort condition frames))
                 (:frame-locals
                  (let ((entry (pick (second command) frames)))
                    (write-response (list :debugger-ok (if (and entry (car entry)) (frame-locals (car entry)) nil)) stream)))
                 (:inspect-condition
                  (write-response (list :debugger-ok (inspect-object condition)) stream))
                 (:inspect-local
                  (let* ((entry (pick (second command) frames))
                         (variables (and entry (car entry) (frame-variables (car entry))))
                         (variable (pick (third command) variables)))
                    (write-response
                     (if (and variable (not (eq (cdr variable) :%unavailable)))
                         (list :debugger-ok (inspect-object (cdr variable)))
                         (list :debugger-error "no such local"))
                     stream)))
                 (t (write-response (list :debugger-error (format nil "unknown debugger command ~S" (first command))) stream)))
             (error (e)
               (write-response (list :debugger-error (one-line (handler-case (princ-to-string e) (error () "error")))) stream)))))))))

;;; ------------------------------------------------------------------ evaluation (needs the debugger and the inspector)

(defun evaluate-text (text package-name &key debugger stream)
  "Evaluate every form of TEXT in PACKAGE-NAME, as a REPL would but with the
   streams captured. Returns (:ok :values (...) :output \"...\" :package \"...\")
   or (:error message :output \"...\" :backtrace (...) [:aborted t]).
   Without DEBUGGER, errors, BREAK and interrupts abandon the evaluation and
   come back with a backtrace. With DEBUGGER (and the client STREAM), they open
   a debugger loop on this thread instead: the client picks a restart, which
   resumes the evaluation, or aborts it."
  (let* ((package (or (find-package* package-name) (find-package :cl-user)))
         (output (make-string-output-stream))
         (values '())
         (message nil)
         (backtrace nil)
         (aborted nil))
    (flet ((abort-with (condition)
             (setf message (one-line (handler-case (princ-to-string condition) (error () "error")))
                   backtrace (capture-backtrace))
             (throw 'moro-eval-abort nil))
           (abort-from-debugger (condition frames)
             (setf message (format nil "~A (aborted)" (one-line (handler-case (princ-to-string condition) (error () "error"))))
                   backtrace (mapcar #'cdr frames)
                   aborted t)
             (throw 'moro-eval-abort nil)))
      (let ((handle (if (and debugger stream)
                        (lambda (condition) (debug-condition condition stream package #'abort-from-debugger))
                        #'abort-with)))
        (setf *eval-thread* (current-thread))
        (unwind-protect
             (catch 'moro-eval-abort
               (let ((*outer-restarts* (compute-restarts))
                     (*package* package)
                     (*standard-output* output) (*error-output* output) (*trace-output* output)
                     (*standard-input* (make-string-input-stream ""))
                     (*debugger-hook* (lambda (condition hook) (declare (ignore hook)) (funcall handle condition)))
                     #+sbcl (sb-ext:*invoke-debugger-hook* (lambda (condition hook) (declare (ignore hook)) (funcall handle condition))))
                 (restart-case
                     (handler-bind ((error handle)
                                    (warning (lambda (condition)
                                               (format output "~&;; ~A~%" (one-line (princ-to-string condition)))
                                               (muffle-warning condition))))
                       (with-input-from-string (in text)
                         (loop for form = (read in nil in)
                               until (eq form in)
                               do (setf values (multiple-value-list (eval form))))))
                   (abort ()
                     :report "Return to the editor, abandoning the evaluation"
                     (setf message (or message "Aborted") aborted t)))))
          (setf *eval-thread* nil))))
    (if message
        (append (list :error message :output (get-output-stream-string output) :backtrace backtrace)
                (and aborted (list :aborted t)))
        (list :ok :values (mapcar (lambda (value) (safe-prin1 value package)) values)
                  :output (get-output-stream-string output)
                  :package (package-name package)))))

(defun interrupt-evaluation ()
  "Stop the running evaluation: an error with a backtrace while it computes, a plain abort while it waits in the debugger."
  (let ((thread *eval-thread*))
    (when thread
      (interrupt-thread thread (lambda ()
                                 (let ((abort *debugger-abort*))
                                   (if abort
                                       (funcall abort)
                                       (error "Interrupted from the editor")))))
      t)))

;;; ------------------------------------------------------------------ protocol

(defun dispatch (request)
  (let ((op (and (consp request) (first request))))
    (case op
      (:connect
       (list :ok :implementation (lisp-implementation-type) :version (lisp-implementation-version)
             :package (package-name *package*)
             :features (list #+(or sbcl ccl ecl abcl) :definitions #+(or sbcl ccl ecl abcl) :arglists)))
      (:packages
       (list :ok (sort (loop for package in (list-all-packages)
                             append (cons (package-name package) (copy-list (package-nicknames package))))
                       #'string<)))
      (:arglist
       (let* ((symbol (resolve (second request) (third request)))
              (lambda-list (and symbol (arglist symbol))))
         (if (or (null symbol) (eq lambda-list :unknown))
             (list :none)
             (list :ok (render lambda-list)))))
      (:documentation
       (let ((symbol (resolve (second request) (third request))))
         (if (null symbol)
             (list :none)
             (let ((lambda-list (arglist symbol)))
               (list :ok
                     :name (string-downcase (symbol-name symbol))
                     :package (let ((package (symbol-package symbol))) (if package (package-name package) ""))
                     :kinds (kinds symbol)
                     :arglist (if (eq lambda-list :unknown) nil (render lambda-list))
                     :docs (symbol-documentation symbol))))))
      (:complete
       (list :ok (completions (string (second request)) (third request))))
      (:definition
       (let ((symbol (resolve (second request) (third request))))
         (if (null symbol)
             (list :none)
             (let ((sources (definition-sources symbol)))
               (if sources (list :ok sources) (list :none))))))
      (:eval (evaluate-text (string (second request)) (third request)
                            :debugger (getf (cdddr request) :debugger) :stream *client-stream*))
      (:interrupt (list :ok (if (interrupt-evaluation) t nil)))
      (:inspect (inspect-text (string (second request)) (third request)))
      (:inspect-part (inspect-part (second request)))
      (:inspect-pop (inspect-pop))
      (:inspect-view (inspector-view))
      ;; Debugger commands arriving after the debugger loop ended: answered in
      ;; kind so the client's bookkeeping stays aligned.
      ((:invoke-restart :abort :frame-locals :inspect-condition :inspect-local)
       (list :debugger-error "no debugger is active"))
      (t (list :error (format nil "unknown request ~S" op))))))

(defun serve (stream)
  (unwind-protect
       (let ((first (read-line stream nil nil))
             (*client-stream* stream))
         (if (and first *token* (string= (string-trim '(#\Return #\Space #\Newline) first) *token*))
             (loop for request = (read-request stream)
                   until (eq request :eof)
                   do (write-response
                       (if (and (consp request) (eq (first request) :%unreadable))
                           (list :error (second request))
                           (handler-case (dispatch request)
                             (error (e) (list :error (one-line (handler-case (princ-to-string e) (error () "error")))))))
                       stream))
             (write-response (list :error "bad token") stream)))
    (ignore-errors (close stream))))

(defun accept-loop (server)
  "Each client gets its own thread, so an evaluation never delays completion."
  (loop
    (let ((stream (handler-case (accept-client server) (error () (return)))))
      (when stream
        (spawn "moro client" (lambda () (handler-case (serve stream) (error () nil))))))))

(defun read-token (file)
  (with-open-file (in file :external-format :utf-8)
    (string-trim '(#\Return #\Newline #\Space) (or (read-line in nil "") ""))))

(defun stop ()
  "Stop the backend if it is running."
  (when *server*
    (ignore-errors (close-server *server*))
    (setf *server* nil *port* nil))
  #+sbcl (when (and *thread* (sb-thread:thread-alive-p *thread*)) (ignore-errors (sb-thread:terminate-thread *thread*)))
  (setf *thread* nil)
  t)

(defun start (port token-file)
  "Start serving moro requests on 127.0.0.1:PORT, authenticated with the token in TOKEN-FILE."
  (handler-case
      (progn
        (stop)
        #-(or sbcl ecl ccl abcl) (progn (format *error-output* "~&;; moro: no backend for ~A~%" (lisp-implementation-type))
                                        (return-from start nil))
        (setf *token* (read-token token-file))
        (let ((server (make-server port)))
          (setf *server* server *port* port)
          (setf *thread* (spawn "moro backend" (lambda () (accept-loop server))))
          (format t "~&;; moro backend listening on 127.0.0.1:~D~%" port)
          (finish-output)
          port))
    (error (e)
      (format *error-output* "~&;; moro backend could not start: ~A~%" e)
      nil)))

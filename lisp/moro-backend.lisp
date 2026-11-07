;;;; moro-backend.lisp -- introspection server loaded into the REPL image by moro,
;;;; the Common Lisp extension for Visual Studio Code.
;;;;
;;;; (moro-backend:start port token-file) listens on 127.0.0.1:PORT in a
;;;; background thread. A client sends the contents of TOKEN-FILE as its first
;;;; line, then one request per line; every request gets one response form.
;;;; Requests are read with *READ-EVAL* bound to NIL and never evaluated, so the
;;;; only thing a client can do is ask about symbols: arglists, documentation,
;;;; completions, packages and source locations of what is loaded right now.
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

;;; ------------------------------------------------------------------ threads

(defun spawn (name function)
  #+sbcl (sb-thread:make-thread function :name name)
  #+ecl (mp:process-run-function name function)
  #+ccl (ccl:process-run-function name function)
  #+abcl (threads:make-thread function :name name)
  #-(or sbcl ecl ccl abcl) (progn name function nil))

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

;;; ------------------------------------------------------------------ printing

(defun strip-packages (x)
  "Replace symbols foreign to CL with uninterned copies so arglists print without package prefixes."
  (cond ((null x) nil)
        ((symbolp x) (if (or (keywordp x) (eq (symbol-package x) (find-package :cl))) x (make-symbol (symbol-name x))))
        ((consp x) (cons (strip-packages (car x)) (strip-packages (cdr x))))
        (t x)))

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
             #+ccl (ccl:arglist (macro-function symbol))
             #+ecl (ext:function-lambda-list (macro-function symbol))
             #+abcl (values (ext:arglist (macro-function symbol)))
             #-(or sbcl ccl ecl abcl) :unknown)
            ((special-operator-p symbol)
             #+sbcl (sb-introspect:function-lambda-list symbol)
             #-sbcl :unknown)
            ((fboundp symbol)
             #+sbcl (sb-introspect:function-lambda-list symbol)
             #+ccl (ccl:arglist symbol)
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

(defun definition-sources (symbol)
  "Source locations as (:file path :offset n) or (:file path :form n) lists; SBCL only."
  #+sbcl
  (let ((out '()))
    (dolist (type '(:function :macro :generic-function :method :variable :constant :class :condition :structure :type :setf-expander :compiler-macro))
      (dolist (source (handler-case (sb-introspect:find-definition-sources-by-name symbol type) (error () nil)))
        (let ((pathname (sb-introspect:definition-source-pathname source)))
          (when pathname
            (let* ((physical (handler-case (translate-logical-pathname pathname) (error () pathname)))
                   (file (namestring physical))
                   (offset (sb-introspect:definition-source-character-offset source))
                   (path (sb-introspect:definition-source-form-path source)))
              (pushnew (list :file file (if offset :offset :form) (or offset (first path) 0) :type type)
                       out :test #'equal))))))
    (nreverse out))
  #-sbcl (progn symbol nil))

(defun one-line (text)
  "TEXT with line breaks collapsed, for error messages."
  (with-output-to-string (out)
    (let ((space nil))
      (loop for ch across text
            do (if (member ch '(#\Newline #\Return #\Tab #\Space))
                   (setf space t)
                   (progn (when space (write-char #\Space out) (setf space nil))
                          (write-char ch out)))))))

;;; ------------------------------------------------------------------ protocol

(defun dispatch (request)
  (let ((op (and (consp request) (first request))))
    (case op
      (:connect
       (list :ok :implementation (lisp-implementation-type) :version (lisp-implementation-version)
             :package (package-name *package*)
             :features (list #+sbcl :definitions #+(or sbcl ccl ecl abcl) :arglists)))
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
      (t (list :error (format nil "unknown request ~S" op))))))

(defun read-request (line)
  (let ((*read-eval* nil) (*package* (find-package :moro-backend)))
    (values (read-from-string line))))

(defun serve (stream)
  (unwind-protect
       (let ((first (read-line stream nil nil)))
         (if (and first *token* (string= (string-trim '(#\Return #\Space #\Newline) first) *token*))
             (loop for line = (read-line stream nil nil)
                   while line
                   do (write-response
                       (handler-case (dispatch (read-request line))
                         (error (e) (list :error (one-line (handler-case (princ-to-string e) (error () "error"))))))
                       stream))
             (write-response (list :error "bad token") stream)))
    (ignore-errors (close stream))))

(defun accept-loop (server)
  (loop
    (let ((stream (handler-case (accept-client server) (error () (return)))))
      (when stream
        (handler-case (serve stream) (error () nil))))))

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

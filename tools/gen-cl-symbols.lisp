;;;; gen-cl-symbols.lisp -- generate data/cl-symbols.json from a running SBCL.
;;;;
;;;; Usage:
;;;;   sbcl --script tools/gen-cl-symbols.lisp [path/to/Map_Sym.txt] > data/cl-symbols.json
;;;;
;;;; For every external symbol of the COMMON-LISP package this records what the
;;;; symbol names (function, macro, special operator, variable, constant, class,
;;;; type, lambda-list keyword, declaration), its lambda list and docstrings as
;;;; SBCL reports them, and the HyperSpec page from Map_Sym.txt when that file
;;;; is given (download it from
;;;; http://www.lispworks.com/documentation/HyperSpec/Data/Map_Sym.txt).
;;;;
;;;; The output is consumed by the language server (hover, completion, signature
;;;; help) and by tools/build-grammar.mjs (syntax highlighting classes).

(require :sb-introspect)

(defparameter *extra-docs*
  '(("loop" . "LOOP {simple-loop | extended-loop}

Simple LOOP: evaluates the body forms forever; exit with RETURN.
Extended LOOP: iteration clauses (FOR/AS/WITH/REPEAT), main clauses (DO, COLLECT,
APPEND, NCONC, SUM, COUNT, MINIMIZE, MAXIMIZE, WHEN/IF/UNLESS, WHILE, UNTIL,
ALWAYS, NEVER, THEREIS, RETURN) and INITIALLY/FINALLY epilogues.")
    ("declare" . "(declare declaration-specifier*)

Provides declarations about variables, functions and code to the compiler.
Allowed only at the start of certain bodies (LET, DEFUN, LAMBDA, ...).")
    ("optimize" . "Declaration: (optimize (quality value)*) with qualities SPEED, SAFETY, DEBUG, SPACE and COMPILATION-SPEED, each from 0 to 3.")
    ("speed" . "OPTIMIZE quality: how fast the code should run (0-3).")
    ("safety" . "OPTIMIZE quality: how much run-time error checking to keep (0-3).")
    ("debug" . "OPTIMIZE quality: how much debugging information to keep (0-3).")
    ("space" . "OPTIMIZE quality: how small the code and its run-time storage should be (0-3).")
    ("compilation-speed" . "OPTIMIZE quality: how fast compilation itself should be (0-3).")
    ("inline" . "Declaration: (inline function-name*) asks the compiler to inline calls to the named functions.")
    ("notinline" . "Declaration: (notinline function-name*) forbids inlining calls to the named functions.")
    ("ignore" . "Declaration: (ignore var*) states that the bindings are never referenced.")
    ("ignorable" . "Declaration: (ignorable var*) states that the bindings may or may not be referenced; no warning either way.")
    ("dynamic-extent" . "Declaration: (dynamic-extent var*) promises that the objects bound to the variables are not referenced after the binding form exits.")
    ("ftype" . "Declaration: (ftype type function-name*) declares the function type of the named functions.")
    ("special" . "Declaration: (special var*) declares the variables to be dynamically scoped.")
    ("otherwise" . "The fallthrough key in CASE, CCASE, ECASE, TYPECASE, CTYPECASE and ETYPECASE clauses; also T.")
    ("lambda" . "(lambda lambda-list [[declaration* | documentation]] form*)

Denotes an anonymous function. As a macro, (lambda ...) expands to (function (lambda ...)).")
    ("&optional" . "Lambda-list keyword: the parameters that follow are optional; each may be VAR or (VAR [init-form [supplied-p-parameter]]).")
    ("&rest" . "Lambda-list keyword: the single parameter that follows is bound to a list of the remaining arguments.")
    ("&body" . "Lambda-list keyword (macro lambda lists): like &REST, and tells editors that the remaining forms are a body for indentation.")
    ("&key" . "Lambda-list keyword: the parameters that follow are keyword arguments; each may be VAR, (VAR [init-form [supplied-p]]) or ((KEYWORD VAR) [init-form [supplied-p]]).")
    ("&allow-other-keys" . "Lambda-list keyword: after &KEY parameters, permits keyword arguments that were not listed.")
    ("&aux" . "Lambda-list keyword: the variables that follow are local bindings, not parameters; each may be VAR or (VAR init-form).")
    ("&whole" . "Lambda-list keyword (macro lambda lists): the parameter that follows is bound to the entire macro call form.")
    ("&environment" . "Lambda-list keyword (macro lambda lists): the parameter that follows is bound to the lexical environment of the macro call.")
    ("satisfies" . "Type specifier: (satisfies predicate-name) denotes the objects for which the named function returns true.")
    ("member" . "Type specifier: (member object*) denotes the set of the listed objects (compared with EQL).")
    ("eql" . "Type specifier: (eql object) denotes the single object EQL to the given one. Also a function comparing two objects.")
    ("mod" . "Type specifier: (mod n) denotes the non-negative integers below n. Also a function computing modulus.")
    ("signed-byte" . "Type specifier: (signed-byte s) denotes integers representable in s bits two's complement; (signed-byte *) is INTEGER.")
    ("unsigned-byte" . "Type specifier: (unsigned-byte s) denotes non-negative integers representable in s bits; (unsigned-byte *) is the non-negative integers.")
    ("values" . "Type specifier: (values type* [&optional type*] [&rest type]) describes multiple values in FUNCTION or THE types. Also the function returning its arguments as multiple values.")))

(defparameter *declaration-identifiers*
  '("optimize" "speed" "safety" "debug" "space" "compilation-speed" "inline"
    "notinline" "ignore" "ignorable" "dynamic-extent" "ftype" "type" "special"
    "declaration"))

(defparameter *compound-type-specifiers*
  '("and" "or" "not" "member" "satisfies" "values" "eql" "mod" "signed-byte"
    "unsigned-byte" "function" "integer" "rational" "real" "float" "short-float"
    "single-float" "double-float" "long-float" "complex" "array" "simple-array"
    "vector" "simple-vector" "string" "simple-string" "base-string"
    "simple-base-string" "bit-vector" "simple-bit-vector" "cons"))

(defun read-clhs-map (path)
  (let ((table (make-hash-table :test 'equal)))
    (when (and path (probe-file path))
      (with-open-file (in path :external-format :latin-1)
        (loop for name = (read-line in nil)
              for page = (read-line in nil)
              while (and name page)
              do (setf (gethash (string-downcase (string-trim '(#\Return #\Space) name)) table)
                       (let ((p (string-trim '(#\Return #\Space) page)))
                         ;; "../Body/f_mapc_.htm" -> "f_mapc_.htm"
                         (subseq p (1+ (or (position #\/ p :from-end t) -1))))))))
    table))

(defun json-string (s)
  (with-output-to-string (out)
    (write-char #\" out)
    (loop for ch across s
          do (case ch
               (#\" (write-string "\\\"" out))
               (#\\ (write-string "\\\\" out))
               (#\Newline (write-string "\\n" out))
               (#\Tab (write-string "\\t" out))
               (#\Return (write-string "\\r" out))
               (t (if (< (char-code ch) 32)
                      (format out "\\u~4,'0x" (char-code ch))
                      (write-char ch out)))))
    (write-char #\" out)))

(defun strip-packages (x)
  "Replace symbols foreign to CL with uninterned symbols of the same name so
   lambda lists print without SB-IMPL:: style prefixes."
  (cond ((null x) nil)
        ((symbolp x)
         (if (or (keywordp x) (eq (symbol-package x) (find-package :cl)))
             x
             (make-symbol (symbol-name x))))
        ((consp x) (cons (strip-packages (car x)) (strip-packages (cdr x))))
        (t x)))

(defun render-lambda-list (ll)
  (let ((*print-case* :downcase)
        (*print-gensym* nil)
        (*print-pretty* nil)
        (*print-readably* nil)
        (*package* (find-package :cl)))
    (prin1-to-string (strip-packages ll))))

(defun safe-lambda-list (thing)
  (handler-case (let ((ll (sb-introspect:function-lambda-list thing)))
                  (if (eq ll :unknown) nil (list ll)))
    (error () nil)))

(defun safe-doc (sym kind)
  (handler-case (documentation sym kind) (error () nil)))

(defun symbol-record (sym clhs)
  (let* ((name (string-downcase (symbol-name sym)))
         (kinds '())
         (docs '())
         (arglist nil))
    (flet ((add-kind (k) (setf kinds (append kinds (list k))))
           (add-doc (k d) (when (and d (plusp (length d)))
                            (setf docs (append docs (list (cons k d)))))))
      (cond ((special-operator-p sym)
             (add-kind "special-operator")
             (setf arglist (safe-lambda-list sym)))
            ((macro-function sym)
             (add-kind "macro")
             (setf arglist (safe-lambda-list (macro-function sym))))
            ((fboundp sym)
             (add-kind (if (typep (fdefinition sym) 'generic-function)
                           "generic-function"
                           "function"))
             (setf arglist (safe-lambda-list sym))))
      (when (or (special-operator-p sym) (fboundp sym))
        (add-doc "function" (safe-doc sym 'function)))
      (when (or (boundp sym) (safe-doc sym 'variable))
        (add-kind (if (constantp sym) "constant" "variable"))
        (add-doc "variable" (safe-doc sym 'variable)))
      (cond ((find-class sym nil)
             (add-kind "class")
             (add-doc "type" (or (safe-doc sym 'type) (safe-doc sym 'structure))))
            ((or (sb-ext:valid-type-specifier-p sym)
                 (member name *compound-type-specifiers* :test #'string=))
             (unless (member name '("and" "or" "not" "values" "function") :test #'string=)
               (add-kind "type"))
             (add-doc "type" (safe-doc sym 'type))))
      (when (char= (char name 0) #\&)
        (add-kind "lambda-list-keyword"))
      (when (member name *declaration-identifiers* :test #'string=)
        (add-kind "declaration"))
      (when (string= name "declare")
        (add-kind "special-operator"))
      (let ((extra (cdr (assoc name *extra-docs* :test #'string=))))
        (when (and extra (null docs))
          (add-doc (cond ((member "lambda-list-keyword" kinds :test #'string=) "lambda-list")
                         ((member "declaration" kinds :test #'string=) "declaration")
                         ((null kinds) "symbol")
                         (t (first kinds)))
                   extra)))
      (when (null kinds) (add-kind "symbol"))
      (with-output-to-string (out)
        (format out "{\"name\":~A,\"kinds\":[~{~A~^,~}]"
                (json-string name) (mapcar #'json-string kinds))
        (when arglist
          (format out ",\"arglist\":~A" (json-string (render-lambda-list (first arglist)))))
        (when docs
          (format out ",\"doc\":{~{~A~^,~}}"
                  (mapcar (lambda (d) (format nil "~A:~A" (json-string (car d)) (json-string (cdr d))))
                          docs)))
        (let ((page (gethash name clhs)))
          (when page (format out ",\"clhs\":~A" (json-string page))))
        (write-char #\} out)))))

(defun main ()
  (let* ((args (rest sb-ext:*posix-argv*))
         (map-path (find-if (lambda (a) (search ".txt" a)) args))
         (clhs (read-clhs-map map-path))
         (symbols (let ((acc '()))
                    (do-external-symbols (s :cl) (push s acc))
                    (sort acc #'string< :key #'symbol-name)))
         (records (mapcar (lambda (s) (symbol-record s clhs)) symbols)))
    (format t "{~%\"generator\":~A,~%\"count\":~D,~%\"symbols\":[~%~{~A~^,~%~}~%]~%}~%"
            (json-string (format nil "~A ~A" (lisp-implementation-type) (lisp-implementation-version)))
            (length records)
            records)
    (format *error-output* "~D symbols, ~D with CLHS pages, ~D without docs~%"
            (length records)
            (count-if (lambda (s) (gethash (string-downcase (symbol-name s)) clhs)) symbols)
            (count-if (lambda (r) (not (search "\"doc\"" r))) records))))


;;; Fallback descriptions for standard symbols that SBCL ships without a
;;; docstring. Written from the standard; shown only when SBCL has nothing.
(setf *extra-docs*
      (append *extra-docs*
              '(("cond" . "(cond {(test-form form*)}*)

Evaluates each TEST-FORM in turn. For the first one that returns true, evaluates its FORMs and returns their values (or the test's value when the clause has no forms). Returns NIL when no test succeeds.")
                ("and" . "(and form*)

Evaluates the FORMs left to right and returns NIL as soon as one returns NIL; otherwise returns the values of the last form. (and) is T. Also a compound type specifier.")
                ("or" . "(or form*)

Evaluates the FORMs left to right and returns the first non-NIL primary value; otherwise returns the values of the last form. (or) is NIL. Also a compound type specifier.")
                ("setq" . "(setq {var form}*)

Assigns the value of each FORM to the preceding variable, in order. Returns the last value, or NIL.")
                ("prog1" . "(prog1 first-form form*)

Evaluates all the forms and returns the primary value of FIRST-FORM.")
                ("prog2" . "(prog2 first-form second-form form*)

Evaluates all the forms and returns the primary value of SECOND-FORM.")
                ("prog" . "(prog ({var | (var [init-form])}*) declaration* {tag | statement}*)

LET bindings around a TAGBODY, wrapped in a BLOCK named NIL so RETURN works.")
                ("prog*" . "(prog* ({var | (var [init-form])}*) declaration* {tag | statement}*)

Like PROG but binds the variables sequentially, as LET* does.")
                ("progv" . "(progv symbols values form*)

Dynamically binds the symbols in the list SYMBOLS to the corresponding VALUES, then evaluates the FORMs.")
                ("return" . "(return [result])

Returns RESULT (default NIL) from the enclosing block named NIL, such as a LOOP, DO, DOLIST or DOTIMES.")
                ("multiple-value-bind" . "(multiple-value-bind (var*) values-form declaration* form*)

Binds the VARs to the multiple values of VALUES-FORM (missing values are NIL, extra values are ignored) and evaluates the FORMs.")
                ("multiple-value-list" . "(multiple-value-list form)

Returns a list of all the values returned by FORM.")
                ("multiple-value-setq" . "(multiple-value-setq (var*) form)

Assigns the values of FORM to the VARs in order. Returns the primary value of FORM.")
                ("dolist" . "(dolist (var list-form [result-form]) declaration* {tag | statement}*)

Iterates with VAR bound to each element of LIST-FORM's value, then returns RESULT-FORM (default NIL). The body is a TAGBODY inside a BLOCK named NIL.")
                ("dotimes" . "(dotimes (var count-form [result-form]) declaration* {tag | statement}*)

Iterates with VAR bound to the integers from 0 below COUNT-FORM's value, then returns RESULT-FORM (default NIL).")
                ("in-package" . "(in-package name)

Sets *PACKAGE* to the package named NAME (a string designator, not evaluated). Also takes effect at compile time when it appears at top level.")
                ("defclass" . "(defclass class-name (superclass-name*) (slot-specifier*) class-option*)

Defines a class. Slot options: :reader :writer :accessor :allocation :initarg :initform :type :documentation. Class options: (:default-initargs ...), (:documentation ...), (:metaclass ...).")
                ("defgeneric" . "(defgeneric function-name gf-lambda-list [[option | {method-description}*]])

Defines a generic function. Options include (:documentation ...), (:argument-precedence-order ...), (:method-combination ...), (declare ...) and (:method ...) for methods defined inline.")
                ("defmacro" . "(defmacro name lambda-list [[declaration* | documentation]] form*)

Defines NAME as a macro whose expansion is computed by the body. The lambda list may destructure and may use &BODY, &WHOLE and &ENVIRONMENT.")
                ("defmethod" . "(defmethod function-name {method-qualifier}* specialized-lambda-list [[declaration* | documentation]] form*)

Defines a method of a generic function, creating the generic function if needed. Required parameters may be specialized as (var class-name) or (var (eql object)).")
                ("define-symbol-macro" . "(define-symbol-macro symbol expansion)

Defines SYMBOL as a global symbol macro: references to it as a variable are replaced by EXPANSION.")
                ("define-method-combination" . "(define-method-combination name ...)

Defines a new method combination type, in either the short form (built on an operator) or the long form (with method-group specifiers).")
                ("with-open-file" . "(with-open-file (stream filespec option*) declaration* form*)

Opens the file with OPEN, binds STREAM to it for the body, and closes it on exit, including non-local exits. Options: :direction :element-type :if-exists :if-does-not-exist :external-format.")
                ("with-open-stream" . "(with-open-stream (var stream) declaration* form*)

Binds VAR to STREAM for the body and closes the stream on exit.")
                ("with-output-to-string" . "(with-output-to-string (var [string-form] &key element-type) declaration* form*)

Binds VAR to a string output stream and returns the accumulated string; when STRING-FORM (a string with a fill pointer) is given, appends to it and returns the body's values instead.")
                ("with-input-from-string" . "(with-input-from-string (var string &key index start end) declaration* form*)

Binds VAR to a string input stream reading STRING for the body.")
                ("with-slots" . "(with-slots ({slot-name | (variable-name slot-name)}*) instance-form declaration* form*)

Makes the named slots of INSTANCE-FORM's value accessible as variables (through SLOT-VALUE) in the body.")
                ("with-accessors" . "(with-accessors ((variable-name accessor-name)*) instance-form declaration* form*)

Makes the accessors of INSTANCE-FORM's value accessible as variables in the body.")
                ("make-instance" . "(make-instance class &rest initargs &key &allow-other-keys)

Creates and initializes a new instance of CLASS (a class object or class name), passing INITARGS on to INITIALIZE-INSTANCE.")
                ("make-array" . "(make-array dimensions &key element-type initial-element initial-contents adjustable fill-pointer displaced-to displaced-index-offset)

Creates and returns an array. DIMENSIONS is a non-negative integer or a list of them.")
                ("find" . "(find item sequence &key from-end test test-not start end key)

Returns the first element of SEQUENCE that matches ITEM under the test, or NIL.")
                ("find-if" . "(find-if predicate sequence &key from-end start end key)

Returns the first element of SEQUENCE that satisfies PREDICATE, or NIL.")
                ("find-if-not" . "(find-if-not predicate sequence &key from-end start end key)

Returns the first element of SEQUENCE that does not satisfy PREDICATE, or NIL.")
                ("position" . "(position item sequence &key from-end test test-not start end key)

Returns the index of the first element of SEQUENCE that matches ITEM, or NIL.")
                ("position-if" . "(position-if predicate sequence &key from-end start end key)

Returns the index of the first element of SEQUENCE that satisfies PREDICATE, or NIL.")
                ("position-if-not" . "(position-if-not predicate sequence &key from-end start end key)

Returns the index of the first element of SEQUENCE that does not satisfy PREDICATE, or NIL.")
                ("search" . "(search sequence-1 sequence-2 &key from-end test test-not key start1 start2 end1 end2)

Returns the index in SEQUENCE-2 of the first subsequence that matches SEQUENCE-1, or NIL.")
                ("reduce" . "(reduce function sequence &key key from-end start end initial-value)

Combines the elements of SEQUENCE by applying the two-argument FUNCTION to the accumulated result and each element in turn.")
                ("map" . "(map result-type function &rest sequences)

Applies FUNCTION elementwise to the SEQUENCES (stopping at the shortest) and returns a sequence of type RESULT-TYPE, or NIL when RESULT-TYPE is NIL.")
                ("map-into" . "(map-into result-sequence function &rest sequences)

Destructively fills RESULT-SEQUENCE with the results of applying FUNCTION elementwise to the SEQUENCES.")
                ("random" . "(random limit &optional random-state)

Returns a pseudo-random non-negative number less than LIMIT, of the same type as LIMIT (a positive integer or float).")
                ("read-line" . "(read-line &optional stream eof-error-p eof-value recursive-p)

Reads a line of text from STREAM. Returns the line without its newline and a second value that is true when the line was ended by end of file.")
                ("read-char" . "(read-char &optional stream eof-error-p eof-value recursive-p)

Reads and returns the next character from STREAM.")
                ("read-char-no-hang" . "(read-char-no-hang &optional stream eof-error-p eof-value recursive-p)

Like READ-CHAR, but returns NIL immediately when no character is available.")
                ("peek-char" . "(peek-char &optional peek-type stream eof-error-p eof-value recursive-p)

Returns the next character without consuming it. PEEK-TYPE T skips whitespace first; a character skips forward to that character.")
                ("unread-char" . "(unread-char character &optional stream)

Puts CHARACTER, the last one read, back onto the front of STREAM.")
                ("read-byte" . "(read-byte stream &optional eof-error-p eof-value)

Reads and returns one byte from a binary input stream.")
                ("write-byte" . "(write-byte byte stream)

Writes BYTE to a binary output stream and returns it.")
                ("write-char" . "(write-char character &optional stream)

Outputs CHARACTER to STREAM and returns it.")
                ("write-string" . "(write-string string &optional stream &key start end)

Writes the characters of STRING (within START and END) to STREAM and returns STRING.")
                ("write-line" . "(write-line string &optional stream &key start end)

Writes STRING followed by a newline to STREAM and returns STRING.")
                ("terpri" . "(terpri &optional stream)

Outputs a newline to STREAM. Returns NIL.")
                ("fresh-line" . "(fresh-line &optional stream)

Outputs a newline unless STREAM is already at the start of a line. Returns T when it output one.")
                ("finish-output" . "(finish-output &optional stream)

Flushes buffered output and waits until it has reached its destination.")
                ("force-output" . "(force-output &optional stream)

Initiates flushing of buffered output without waiting for it to complete.")
                ("clear-output" . "(clear-output &optional stream)

Discards any buffered output on STREAM.")
                ("clear-input" . "(clear-input &optional stream)

Discards any buffered input on STREAM.")
                ("listen" . "(listen &optional stream)

Returns true when a character is immediately available from STREAM.")
                ("file-position" . "(file-position stream &optional position-spec)

Returns the current position in a file stream, or repositions it when POSITION-SPEC (an integer, :START or :END) is given.")
                ("file-length" . "(file-length stream)

Returns the length of the file associated with STREAM, measured in units of its element type.")
                ("file-string-length" . "(file-string-length stream object)

Returns the number of file elements OBJECT (a string or character) would occupy if written to STREAM, or NIL if unknown.")
                ("string-upcase" . "(string-upcase string &key start end)

Returns a copy of STRING (a string designator) with the characters in the range converted to uppercase.")
                ("string-downcase" . "(string-downcase string &key start end)

Returns a copy of STRING (a string designator) with the characters in the range converted to lowercase.")
                ("string-capitalize" . "(string-capitalize string &key start end)

Returns a copy of STRING with the first character of each word uppercased and the rest lowercased.")
                ("nstring-upcase" . "(nstring-upcase string &key start end)

Destructive version of STRING-UPCASE: modifies and returns STRING.")
                ("nstring-downcase" . "(nstring-downcase string &key start end)

Destructive version of STRING-DOWNCASE: modifies and returns STRING.")
                ("nstring-capitalize" . "(nstring-capitalize string &key start end)

Destructive version of STRING-CAPITALIZE: modifies and returns STRING.")
                ("string-trim" . "(string-trim character-bag string)

Returns a substring of STRING with every character in CHARACTER-BAG removed from both ends.")
                ("string-left-trim" . "(string-left-trim character-bag string)

Returns a substring of STRING with every character in CHARACTER-BAG removed from the beginning.")
                ("string-right-trim" . "(string-right-trim character-bag string)

Returns a substring of STRING with every character in CHARACTER-BAG removed from the end.")
                ("butlast" . "(butlast list &optional n)

Returns a copy of LIST without its last N (default 1) elements.")
                ("nbutlast" . "(nbutlast list &optional n)

Destructive version of BUTLAST: may modify LIST.")
                ("slot-value" . "(slot-value object slot-name)

Returns the value of the named slot of OBJECT. SETF-able.")
                ("slot-boundp" . "(slot-boundp instance slot-name)

Returns true when the named slot of INSTANCE has a value.")
                ("slot-exists-p" . "(slot-exists-p object slot-name)

Returns true when OBJECT has a slot named SLOT-NAME.")
                ("slot-makunbound" . "(slot-makunbound instance slot-name)

Makes the named slot of INSTANCE unbound. Returns INSTANCE.")
                ("class-of" . "(class-of object)

Returns the class of which OBJECT is a direct instance.")
                ("class-name" . "(class-name class)

Returns the name of CLASS. SETF-able.")
                ("find-class" . "(find-class symbol &optional errorp environment)

Returns the class named SYMBOL. Signals an error when there is none and ERRORP is true (the default); returns NIL otherwise. SETF-able.")
                ("print-object" . "(print-object object stream)

Generic function that prints OBJECT to STREAM; specialize it to customize printing (see PRINT-UNREADABLE-OBJECT).")
                ("describe-object" . "(describe-object object stream)

Generic function called by DESCRIBE; specialize it to customize the description of OBJECT.")
                ("initialize-instance" . "(initialize-instance instance &rest initargs &key &allow-other-keys)

Generic function called by MAKE-INSTANCE to initialize a new instance. Define :AFTER methods to customize initialization.")
                ("reinitialize-instance" . "(reinitialize-instance instance &rest initargs &key &allow-other-keys)

Generic function that reinitializes the slots of an existing instance from INITARGS.")
                ("shared-initialize" . "(shared-initialize instance slot-names &rest initargs &key &allow-other-keys)

Generic function that fills the slots of INSTANCE from INITARGS and initforms; called by INITIALIZE-INSTANCE and REINITIALIZE-INSTANCE.")
                ("change-class" . "(change-class instance new-class &key &allow-other-keys)

Changes the class of INSTANCE to NEW-CLASS, preserving the slots they share, then calls UPDATE-INSTANCE-FOR-DIFFERENT-CLASS.")
                ("update-instance-for-different-class" . "(update-instance-for-different-class previous current &rest initargs)

Generic function called by CHANGE-CLASS after the class of an instance has been changed.")
                ("update-instance-for-redefined-class" . "(update-instance-for-redefined-class instance added-slots discarded-slots property-list &rest initargs)

Generic function called when an instance is updated after its class was redefined.")
                ("make-instances-obsolete" . "(make-instances-obsolete class)

Marks the existing instances of CLASS as needing update the next time they are accessed.")
                ("make-load-form" . "(make-load-form object &optional environment)

Generic function returning the forms the file compiler uses to recreate OBJECT (a literal in compiled code) at load time.")
                ("make-load-form-saving-slots" . "(make-load-form-saving-slots object &key slot-names environment)

Returns creation and initialization forms that recreate OBJECT by saving its slots; for use in MAKE-LOAD-FORM methods.")
                ("allocate-instance" . "(allocate-instance class &rest initargs &key &allow-other-keys)

Generic function that allocates a new, uninitialized instance of CLASS.")
                ("add-method" . "(add-method generic-function method)

Adds METHOD to GENERIC-FUNCTION, replacing any method with the same qualifiers and specializers.")
                ("remove-method" . "(remove-method generic-function method)

Removes METHOD from GENERIC-FUNCTION.")
                ("find-method" . "(find-method generic-function method-qualifiers specializers &optional errorp)

Returns the method of GENERIC-FUNCTION with the given qualifiers and specializers.")
                ("ensure-generic-function" . "(ensure-generic-function function-name &key argument-precedence-order declare documentation environment generic-function-class lambda-list method-class method-combination)

Defines or modifies the generic function named FUNCTION-NAME and returns it.")
                ("compute-applicable-methods" . "(compute-applicable-methods generic-function function-arguments)

Returns the methods of GENERIC-FUNCTION applicable to FUNCTION-ARGUMENTS, most specific first.")
                ("method-qualifiers" . "(method-qualifiers method)

Returns the list of qualifiers of METHOD.")
                ("function-keywords" . "(function-keywords method)

Returns the keyword parameter names of METHOD and whether it allows other keys.")
                ("no-applicable-method" . "(no-applicable-method generic-function &rest function-arguments)

Generic function called when a generic function is invoked with arguments that no method applies to. The default method signals an error.")
                ("no-next-method" . "(no-next-method generic-function method &rest args)

Generic function called when CALL-NEXT-METHOD is used but there is no next method. The default method signals an error.")
                ("call-next-method" . "(call-next-method &rest args)

Within a method body, calls the next most specific applicable method, with the same arguments unless ARGS are given.")
                ("next-method-p" . "(next-method-p)

Within a method body, returns true when there is a next method for CALL-NEXT-METHOD to call.")
                ("call-method" . "(call-method method next-method-list)

Within DEFINE-METHOD-COMBINATION, calls METHOD with the arguments of the generic function.")
                ("make-method" . "(make-method form)

Within DEFINE-METHOD-COMBINATION, makes a method object whose body is FORM, for use with CALL-METHOD.")
                ("invalid-method-error" . "(invalid-method-error method format-control &rest args)

Signals an error about a method whose qualifiers are not valid for the method combination.")
                ("method-combination-error" . "(method-combination-error format-control &rest args)

Signals an error about an invalid method combination.")
                ("slot-missing" . "(slot-missing class object slot-name operation &optional new-value)

Generic function called when a slot accessor is used with a slot name the class does not have.")
                ("slot-unbound" . "(slot-unbound class instance slot-name)

Generic function called when an unbound slot is read. The default method signals UNBOUND-SLOT.")
                ("cerror" . "(cerror continue-format-control datum &rest arguments)

Signals a correctable error with a CONTINUE restart, described by CONTINUE-FORMAT-CONTROL. Returns NIL when the restart is invoked.")
                ("proclaim" . "(proclaim declaration-specifier)

Makes a global declaration at run time (DECLAIM makes it at compile time too).")
                ("inspect" . "(inspect object)

Interactively inspects OBJECT; the interface is implementation defined.")
                ("sxhash" . "(sxhash object)

Returns a non-negative fixnum hash code for OBJECT that is the same for objects that are EQUAL.")
                ("vector-push-extend" . "(vector-push-extend new-element vector &optional extension)

Appends NEW-ELEMENT to a vector with a fill pointer, growing it by EXTENSION when it is adjustable and full. Returns the new element's index.")
                ("formatter" . "(formatter control-string)

Returns a function of (stream &rest args) that performs the FORMAT operation described by the literal CONTROL-STRING.")
                ("array-row-major-index" . "(array-row-major-index array &rest subscripts)

Returns the row-major index of the element of ARRAY at SUBSCRIPTS.")
                ("parse-namestring" . "(parse-namestring thing &optional host default-pathname &key start end junk-allowed)

Parses THING into a pathname. Returns the pathname and the index at which parsing stopped.")
                ("pathnamep" . "(pathnamep object)

Returns true when OBJECT is a pathname.")
                ("packagep" . "(packagep object)

Returns true when OBJECT is a package.")
                ("hash-table-p" . "(hash-table-p object)

Returns true when OBJECT is a hash table.")
                ("random-state-p" . "(random-state-p object)

Returns true when OBJECT is a random state.")
                ("readtablep" . "(readtablep object)

Returns true when OBJECT is a readtable.")
                ("streamp" . "(streamp object)

Returns true when OBJECT is a stream.")
                ("package-name" . "(package-name package)

Returns the name of PACKAGE as a string, or NIL for a deleted package.")
                ("package-nicknames" . "(package-nicknames package)

Returns the list of nickname strings of PACKAGE.")
                ("package-use-list" . "(package-use-list package)

Returns the list of packages used by PACKAGE.")
                ("package-used-by-list" . "(package-used-by-list package)

Returns the list of packages that use PACKAGE.")
                ("package-shadowing-symbols" . "(package-shadowing-symbols package)

Returns the list of symbols declared as shadowing in PACKAGE.")
                ("lisp-implementation-type" . "(lisp-implementation-type)

Returns a string naming the Lisp implementation, or NIL.")
                ("lisp-implementation-version" . "(lisp-implementation-version)

Returns a string identifying the version of the Lisp implementation, or NIL.")
                ("readtable-case" . "(readtable-case readtable)

Returns the case sensitivity mode of READTABLE: :UPCASE, :DOWNCASE, :PRESERVE or :INVERT. SETF-able.")
                ("stream-external-format" . "(stream-external-format stream)

Returns the external format (character encoding) of a file stream.")
                ("get-output-stream-string" . "(get-output-stream-string string-output-stream)

Returns the characters accumulated so far in a string output stream and clears it.")
                ("make-broadcast-stream" . "(make-broadcast-stream &rest streams)

Returns an output stream that sends everything written to it to each of STREAMS.")
                ("make-synonym-stream" . "(make-synonym-stream symbol)

Returns a stream that forwards operations to the stream that is the current value of the variable SYMBOL.")
                ("copy-pprint-dispatch" . "(copy-pprint-dispatch &optional table)

Returns a copy of the pretty print dispatch TABLE (default *PRINT-PPRINT-DISPATCH*).")
                ("pprint-dispatch" . "(pprint-dispatch object &optional table)

Returns the pretty printing function for OBJECT from TABLE and whether one was found.")
                ("set-pprint-dispatch" . "(set-pprint-dispatch type-specifier function &optional priority table)

Installs FUNCTION as the pretty printing function for objects of TYPE-SPECIFIER in TABLE.")
                ("*default-pathname-defaults*" . "The pathname used to fill in missing components of other pathnames, for example in OPEN, LOAD and MERGE-PATHNAMES.")
                ("*load-pathname*" . "Bound by LOAD to the pathname of the file being loaded, or NIL when not loading.")
                ("*load-truename*" . "Bound by LOAD to the truename of the file being loaded, or NIL when not loading.")
                ("*compile-file-pathname*" . "Bound by COMPILE-FILE to the pathname of the file being compiled, or NIL.")
                ("*compile-file-truename*" . "Bound by COMPILE-FILE to the truename of the file being compiled, or NIL.")
                ("*random-state*" . "The default random state object used by RANDOM.")
                ("*read-default-float-format*" . "The float type used when reading a float that has no exponent marker, and whose floats print without one. Initially SINGLE-FLOAT.")
                ("pi" . "The best long-float approximation of the mathematical constant pi.")
                ("t" . "The canonical true value. Also the type and class of all objects, the default in CASE and TYPECASE clauses, and the designator for standard streams in FORMAT.")
                ("nil" . "The empty list and the false value. Also the empty type, the symbol NIL and the name of the block established by LOOP, DO and friends.")
                ("structure" . "Documentation type for DOCUMENTATION: (documentation name 'structure) refers to a structure defined with DEFSTRUCT.")
                ("variable" . "Documentation type for DOCUMENTATION: (documentation name 'variable) refers to a special variable or constant.")
                ("type" . "Declaration identifier: (type typespec var*) declares the type of variables. Also the DOCUMENTATION type for type specifiers.")
                ("declaration" . "Declaration identifier: (declaration name*) tells the compiler that the names are valid declaration identifiers so it does not warn about them.")
                ("standard" . "The name of the standard method combination, used by default and selectable with (:method-combination standard).")
                ("compiler-macro" . "Documentation type for DOCUMENTATION: (documentation name 'compiler-macro) refers to a compiler macro defined with DEFINE-COMPILER-MACRO.")
                ("condition" . "Class: the root of all condition types.")
                ("restart" . "Class: restart objects, as returned by COMPUTE-RESTARTS and FIND-RESTART and used by INVOKE-RESTART.")
                ("serious-condition" . "Condition class: conditions serious enough to enter the debugger if unhandled. Supertype of ERROR and STORAGE-CONDITION.")
                ("warning" . "Condition class: conditions that WARN reports without entering the debugger.")
                ("style-warning" . "Condition class: warnings about code that is correct but could be written better.")
                ("storage-condition" . "Condition class: a storage problem such as running out of memory or stack.")
                ("simple-condition" . "Condition class: conditions with a format control and arguments; see SIMPLE-CONDITION-FORMAT-CONTROL.")
                ("simple-error" . "Condition class: an ERROR with a format control and arguments, as signaled by (error \"...\" ...).")
                ("simple-warning" . "Condition class: a WARNING with a format control and arguments, as signaled by (warn \"...\" ...).")
                ("simple-type-error" . "Condition class: a TYPE-ERROR with a format control and arguments.")
                ("type-error" . "Condition class: an object was not of the expected type. See TYPE-ERROR-DATUM and TYPE-ERROR-EXPECTED-TYPE.")
                ("program-error" . "Condition class: an error in a program itself, such as a malformed form or wrong argument count.")
                ("control-error" . "Condition class: an invalid transfer of control, such as a RETURN-FROM to a block that no longer exists.")
                ("parse-error" . "Condition class: an error while parsing, for example in PARSE-INTEGER.")
                ("reader-error" . "Condition class: an error signaled by the Lisp reader; a PARSE-ERROR and STREAM-ERROR.")
                ("stream-error" . "Condition class: an error related to a stream. See STREAM-ERROR-STREAM.")
                ("end-of-file" . "Condition class: an attempt to read past the end of a stream.")
                ("file-error" . "Condition class: an error related to a file, such as a missing file. See FILE-ERROR-PATHNAME.")
                ("package-error" . "Condition class: an error related to a package, such as a name conflict. See PACKAGE-ERROR-PACKAGE.")
                ("cell-error" . "Condition class: an error accessing a location, such as an unbound variable. See CELL-ERROR-NAME.")
                ("unbound-variable" . "Condition class: a variable without a value was referenced.")
                ("undefined-function" . "Condition class: a function that is not defined was called.")
                ("unbound-slot" . "Condition class: an unbound slot was read. See UNBOUND-SLOT-INSTANCE.")
                ("arithmetic-error" . "Condition class: an error in an arithmetic operation. See ARITHMETIC-ERROR-OPERATION and ARITHMETIC-ERROR-OPERANDS.")
                ("division-by-zero" . "Condition class: an attempt to divide by zero.")
                ("floating-point-overflow" . "Condition class: a floating point result was too large to represent.")
                ("floating-point-underflow" . "Condition class: a floating point result was too small to represent.")
                ("floating-point-inexact" . "Condition class: a floating point operation produced an inexact result (when trapped).")
                ("floating-point-invalid-operation" . "Condition class: an invalid floating point operation, such as taking the square root of a negative number.")
                ("print-not-readable" . "Condition class: an object could not be printed readably while *PRINT-READABLY* was true. See PRINT-NOT-READABLE-OBJECT.")
                ("class" . "Class: the superclass of all classes.")
                ("built-in-class" . "Class: the class of classes that are predefined and cannot be subclassed or instantiated with MAKE-INSTANCE.")
                ("standard-class" . "Class: the default metaclass of classes defined with DEFCLASS.")
                ("structure-class" . "Class: the class of structures defined with DEFSTRUCT.")
                ("standard-object" . "Class: the default superclass of classes defined with DEFCLASS.")
                ("structure-object" . "Class: the superclass of all structures defined with DEFSTRUCT.")
                ("generic-function" . "Class: the superclass of all generic functions.")
                ("standard-generic-function" . "Class: the default class of generic functions defined with DEFGENERIC.")
                ("method" . "Class: the superclass of all methods.")
                ("standard-method" . "Class: the default class of methods defined with DEFMETHOD.")
                ("method-combination" . "Class: the superclass of all method combination objects.")
                ("symbol" . "Class: symbols, with a name, package, value, function and property list.")
                ("keyword" . "Type: symbols in the KEYWORD package, which evaluate to themselves.")
                ("boolean" . "Type: the symbols T and NIL.")
                ("number" . "Class: all numbers; the supertype of REAL and COMPLEX.")
                ("real" . "Class: all real numbers; the supertype of RATIONAL and FLOAT. (real low high) bounds the interval.")
                ("integer" . "Class: all integers; the supertype of FIXNUM and BIGNUM. (integer low high) bounds the interval.")
                ("fixnum" . "Type: integers that fit in a machine word, between MOST-NEGATIVE-FIXNUM and MOST-POSITIVE-FIXNUM.")
                ("bignum" . "Type: integers that are not fixnums.")
                ("ratio" . "Class: rational numbers that are not integers.")
                ("short-float" . "Type: the smallest floating point format; may be the same as SINGLE-FLOAT.")
                ("single-float" . "Type: single precision floating point numbers (marker f or F).")
                ("double-float" . "Type: double precision floating point numbers (marker d or D).")
                ("long-float" . "Type: the largest floating point format; may be the same as DOUBLE-FLOAT (marker l or L).")
                ("sequence" . "Class: ordered collections, the supertype of LIST and VECTOR.")
                ("array" . "Class: all arrays. (array element-type dimensions) constrains them.")
                ("simple-array" . "Type: arrays that are not displaced, not adjustable and have no fill pointer.")
                ("simple-vector" . "Type: simple one-dimensional arrays with element type T.")
                ("bit-vector" . "Class: one-dimensional arrays of bits.")
                ("simple-bit-vector" . "Type: bit vectors that are simple arrays.")
                ("simple-string" . "Type: strings that are simple arrays.")
                ("base-string" . "Type: strings whose elements are BASE-CHARs.")
                ("simple-base-string" . "Type: base strings that are simple arrays.")
                ("base-char" . "Type: the characters in the standard character repertoire and others the implementation chooses; a subtype of CHARACTER.")
                ("compiled-function" . "Type: functions that have been compiled.")
                ("hash-table" . "Class: hash tables created with MAKE-HASH-TABLE.")
                ("random-state" . "Class: the state of the pseudo-random number generator used by RANDOM.")
                ("stream" . "Class: all streams.")
                ("file-stream" . "Class: streams connected to files, as returned by OPEN.")
                ("string-stream" . "Class: streams that read from or write to strings.")
                ("broadcast-stream" . "Class: output streams that write to several streams (MAKE-BROADCAST-STREAM).")
                ("concatenated-stream" . "Class: input streams that read from several streams in turn (MAKE-CONCATENATED-STREAM).")
                ("echo-stream" . "Class: streams that echo what they read to an output stream (MAKE-ECHO-STREAM).")
                ("synonym-stream" . "Class: streams that forward to the stream held by a variable (MAKE-SYNONYM-STREAM).")
                ("two-way-stream" . "Class: streams combining an input and an output stream (MAKE-TWO-WAY-STREAM).")
                ("broadcast-stream-streams" . "(broadcast-stream-streams broadcast-stream)

Returns the list of streams a broadcast stream writes to.")
                ("concatenated-stream-streams" . "(concatenated-stream-streams concatenated-stream)

Returns the list of streams a concatenated stream still has to read.")
                ("echo-stream-input-stream" . "(echo-stream-input-stream echo-stream)

Returns the input stream of an echo stream.")
                ("echo-stream-output-stream" . "(echo-stream-output-stream echo-stream)

Returns the output stream of an echo stream.")
                ("two-way-stream-input-stream" . "(two-way-stream-input-stream two-way-stream)

Returns the input stream of a two-way stream.")
                ("two-way-stream-output-stream" . "(two-way-stream-output-stream two-way-stream)

Returns the output stream of a two-way stream.")
                ("synonym-stream-symbol" . "(synonym-stream-symbol synonym-stream)

Returns the symbol whose value a synonym stream forwards to.")
                ("arithmetic-error-operands" . "(arithmetic-error-operands condition)

Returns the operands of the operation that signaled an ARITHMETIC-ERROR.")
                ("arithmetic-error-operation" . "(arithmetic-error-operation condition)

Returns the operation that signaled an ARITHMETIC-ERROR.")
                ("cell-error-name" . "(cell-error-name condition)

Returns the name of the cell (variable, function or slot) involved in a CELL-ERROR.")
                ("file-error-pathname" . "(file-error-pathname condition)

Returns the pathname involved in a FILE-ERROR.")
                ("package-error-package" . "(package-error-package condition)

Returns the package involved in a PACKAGE-ERROR.")
                ("print-not-readable-object" . "(print-not-readable-object condition)

Returns the object that could not be printed readably.")
                ("simple-condition-format-control" . "(simple-condition-format-control condition)

Returns the format control of a SIMPLE-CONDITION.")
                ("simple-condition-format-arguments" . "(simple-condition-format-arguments condition)

Returns the format arguments of a SIMPLE-CONDITION.")
                ("stream-error-stream" . "(stream-error-stream condition)

Returns the stream involved in a STREAM-ERROR.")
                ("type-error-datum" . "(type-error-datum condition)

Returns the object that was of the wrong type in a TYPE-ERROR.")
                ("type-error-expected-type" . "(type-error-expected-type condition)

Returns the type that was expected in a TYPE-ERROR.")
                ("unbound-slot-instance" . "(unbound-slot-instance condition)

Returns the instance whose slot was unbound in an UNBOUND-SLOT error.")
                ("double-float-epsilon" . "The smallest positive double-float e such that (/= (+ 1 e) 1).")
                ("double-float-negative-epsilon" . "The smallest positive double-float e such that (/= (- 1 e) 1).")
                ("single-float-epsilon" . "The smallest positive single-float e such that (/= (+ 1 e) 1).")
                ("single-float-negative-epsilon" . "The smallest positive single-float e such that (/= (- 1 e) 1).")
                ("short-float-epsilon" . "The smallest positive short-float e such that (/= (+ 1 e) 1).")
                ("short-float-negative-epsilon" . "The smallest positive short-float e such that (/= (- 1 e) 1).")
                ("long-float-epsilon" . "The smallest positive long-float e such that (/= (+ 1 e) 1).")
                ("long-float-negative-epsilon" . "The smallest positive long-float e such that (/= (- 1 e) 1)."))))

;;; Float limit constants: generate their descriptions from the name.
(dolist (prefix '("most-positive" "most-negative" "least-positive" "least-negative"
                  "least-positive-normalized" "least-negative-normalized"))
  (dolist (type '("short-float" "single-float" "double-float" "long-float"))
    (let ((name (format nil "~A-~A" prefix type)))
      (unless (assoc name *extra-docs* :test #'string=)
        (push (cons name
                    (format nil "The ~A ~A~A."
                            (cond ((search "most-positive" name) "largest positive")
                                  ((search "most-negative" name) "most negative (largest magnitude)")
                                  ((search "least-positive" name) "smallest positive")
                                  (t "negative closest to zero"))
                            (if (search "normalized" name) "normalized " "")
                            type))
              *extra-docs*)))))

(main)

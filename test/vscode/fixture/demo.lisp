(defpackage #:demo
  (:use #:cl)
  (:export #:greet))

(in-package #:demo)

(defun greet (name &optional (greeting "Hello"))
  "Greet NAME."
  (format t "~a, ~a!~%" greeting name))

(defun main ()
  (greet "world")
  (mapcar #'greet (list "a" "b")))

(defpackage #:extsys
  (:use #:cl)
  (:export #:ext-fn))
(in-package #:extsys)

(defun ext-fn (x)
  "External system function."
  x)

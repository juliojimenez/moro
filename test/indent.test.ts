import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/common/reader';
import { defaultSettings, indentationForLine, reindentText, DEFAULT_SPECS, IndentSettings } from '../src/server/indent';

/** Each case: name, mis-indented input lines, expected output lines. */
const cases: Array<[string, string[], string[], IndentSettings?]> = [
  [
    'defun with docstring',
    ['(defun foo (x)', '"Doc."', '    (bar x))'],
    ['(defun foo (x)', '  "Doc."', '  (bar x))'],
  ],
  [
    'defun lambda list on its own line',
    ['(defun foo', '(x)', '(bar x))'],
    ['(defun foo', '    (x)', '  (bar x))'],
  ],
  [
    'let bindings align, body indents',
    ['(let ((a 1)', '(b 2))', '(+ a b))'],
    ['(let ((a 1)', '      (b 2))', '  (+ a b))'],
  ],
  [
    'let* bindings',
    ['(let* ((a 1)', '(b (1+ a)))', '(+ a b))'],
    ['(let* ((a 1)', '       (b (1+ a)))', '  (+ a b))'],
  ],
  [
    'let with bare variable list is data',
    ['(let (a b', 'c)', '(list a b c))'],
    ['(let (a b', '      c)', '  (list a b c))'],
  ],
  [
    'flet binding indents like a defun',
    ['(flet ((foo (x)', '(bar x)))', '(foo 1))'],
    ['(flet ((foo (x)', '         (bar x)))', '  (foo 1))'],
  ],
  [
    'labels with two bindings',
    [
      '(labels ((even? (n)',
      '(if (zerop n) t (odd? (1- n))))',
      '(odd? (n)',
      '(if (zerop n) nil (even? (1- n)))))',
      '(even? 10))',
    ],
    [
      '(labels ((even? (n)',
      '           (if (zerop n) t (odd? (1- n))))',
      '         (odd? (n)',
      '           (if (zerop n) nil (even? (1- n)))))',
      '  (even? 10))',
    ],
  ],
  [
    'if aligns then and else under the test',
    ['(if (foo)', '(bar)', '(baz))'],
    ['(if (foo)', '    (bar)', '    (baz))'],
  ],
  ['when body', ['(when (foo)', '(bar)', '(baz))'], ['(when (foo)', '  (bar)', '  (baz))']],
  ['unless body', ['(unless (foo)', '(bar))'], ['(unless (foo)', '  (bar))']],
  [
    'cond clauses align, clause bodies are data',
    ['(cond ((foo)', '(bar))', '(t', '(baz)))'],
    ['(cond ((foo)', '       (bar))', '      (t', '       (baz)))'],
  ],
  [
    'case clauses are body forms',
    ['(case x', '(:a 1)', '(otherwise 2))'],
    ['(case x', '  (:a 1)', '  (otherwise 2))'],
  ],
  [
    'typecase clause body is a plain call shape',
    ['(typecase x', '(string (foo x)', '(bar x))', '(t nil))'],
    ['(typecase x', '  (string (foo x)', '          (bar x))', '  (t nil))'],
  ],
  [
    'do: step list and end test are distinguished',
    ['(do ((i 0 (1+ i)))', '((= i 10))', '(print i))'],
    ['(do ((i 0 (1+ i)))', '    ((= i 10))', '  (print i))'],
  ],
  ['dolist', ['(dolist (x xs)', '(print x))'], ['(dolist (x xs)', '  (print x))']],
  ['dotimes', ['(dotimes (i 10)', '(print i))'], ['(dotimes (i 10)', '  (print i))']],
  [
    'loop: for/when/collect/finally',
    ['(loop for x in xs', 'for y = (foo x)', 'when (bar y)', 'collect y', 'finally (return z))'],
    [
      '(loop for x in xs',
      '      for y = (foo x)',
      '      when (bar y)',
      '        collect y',
      '      finally (return z))',
    ],
  ],
  [
    'loop: do body continuation aligns under the first body form',
    ['(loop for x in xs', 'do (print x)', '(print (* x 2)))'],
    ['(loop for x in xs', '      do (print x)', '         (print (* x 2)))'],
  ],
  [
    'loop: when/else',
    ['(loop for x in xs', 'when (evenp x)', 'collect x', 'else', 'collect (- x))'],
    ['(loop for x in xs', '      when (evenp x)', '        collect x', '      else', '        collect (- x))'],
  ],
  [
    'loop: and continues the conditional body',
    ['(loop for x in xs', 'when (foo x)', 'collect x', 'and do (print x)', 'finally (return 1))'],
    [
      '(loop for x in xs',
      '      when (foo x)',
      '        collect x',
      '        and do (print x)',
      '      finally (return 1))',
    ],
  ],
  [
    'loop: conditional completed on one line',
    ['(loop for x in xs', 'when (evenp x) collect x', 'do (print x))'],
    ['(loop for x in xs', '      when (evenp x) collect x', '      do (print x))'],
  ],
  [
    'loop: keyword-style clause keywords',
    ['(loop :for x :in xs', ':collect x)'],
    ['(loop :for x :in xs', '      :collect x)'],
  ],
  [
    'loop: comment line goes to the clause column',
    ['(loop for x in xs', '; note', 'collect x)'],
    ['(loop for x in xs', '      ; note', '      collect x)'],
  ],
  [
    'simple loop body',
    ['(loop', '(foo)', '(when (bar) (return)))'],
    ['(loop', '  (foo)', '  (when (bar) (return)))'],
  ],
  [
    'loop nested in defun with a call spanning lines',
    ['(defun show (xs)', '(loop for x in xs', 'do (format t "~a~%"', 'x)))'],
    ['(defun show (xs)', '  (loop for x in xs', '        do (format t "~a~%"', '                   x)))'],
  ],
  [
    'loop: nested conditionals go back to the clause column after the body clause',
    ['(loop for x in xs', 'when (a x)', 'when (b x)', 'collect x', 'do (print x))'],
    ['(loop for x in xs', '      when (a x)', '        when (b x)', '          collect x', '      do (print x))'],
  ],
  [
    'loop: continuation keywords on their own line',
    ['(loop for x', 'in xs', 'for y', '= (f x)', 'then (g y)', 'for i', 'from 0', 'below 10', 'collect (list x y i))'],
    [
      '(loop for x',
      '        in xs',
      '      for y',
      '        = (f x)',
      '        then (g y)',
      '      for i',
      '        from 0',
      '        below 10',
      '      collect (list x y i))',
    ],
  ],
  [
    'loop: and inside a conditional body steals the clause indentation',
    ['(loop for x in xs', 'when (a x)', 'collect x', 'and sum x into total', 'and count x', 'finally (return total))'],
    [
      '(loop for x in xs',
      '      when (a x)',
      '        collect x',
      '        and sum x into total',
      '        and count x',
      '      finally (return total))',
    ],
  ],
  [
    'loop: and after a one-line conditional aligns with it',
    ['(loop for x in xs', 'when (evenp x) collect x', 'and do (print x)', 'finally (return 1))'],
    ['(loop for x in xs', '      when (evenp x) collect x', '      and do (print x)', '      finally (return 1))'],
  ],
  [
    'loop: body keyword alone on its line indents its forms three in',
    ['(loop for x in xs', 'do', '(print x)', '(print y)', 'finally', '(return z))'],
    ['(loop for x in xs', '      do', '         (print x)', '         (print y)', '      finally', '         (return z))'],
  ],
  [
    'loop: body keyword ending a conditional line indents two in from the line',
    ['(loop for x in xs', 'when (foo x) do', '(bar x)', '(baz x))'],
    ['(loop for x in xs', '      when (foo x) do', '        (bar x)', '        (baz x))'],
  ],
  [
    'loop: else alone indents the next clause, else with a clause does not',
    ['(loop for x in xs', 'if (a x)', 'collect x', 'else', 'do (print x)', 'finally (return 1))', '(loop for x in xs', 'if (a x)', 'collect x', 'else collect (- x)', 'finally (return 1))'],
    [
      '(loop for x in xs',
      '      if (a x)',
      '        collect x',
      '      else',
      '        do (print x)',
      '      finally (return 1))',
      '(loop for x in xs',
      '      if (a x)',
      '        collect x',
      '      else collect (- x)',
      '      finally (return 1))',
    ],
  ],
  [
    'loop: end goes back to the clause column',
    ['(loop for x in xs', 'when (a x)', 'collect x', 'end', 'do (print x))'],
    ['(loop for x in xs', '      when (a x)', '        collect x', '      end', '      do (print x))'],
  ],
  [
    'loop: clauses after "(loop" on its own line, including and',
    ['(loop', 'for x in xs', 'and y = 1', 'collect x)'],
    ['(loop', '  for x in xs', '  and y = 1', '  collect x)'],
  ],
  [
    'loop: a multi-line test form still counts as the conditional',
    ['(loop for x in xs', 'when (and (a x)', '(b x))', 'collect x', 'finally (return 1))'],
    ['(loop for x in xs', '      when (and (a x)', '                (b x))', '        collect x', '      finally (return 1))'],
  ],
  [
    'loop: a form where a clause was expected aligns under the previous form',
    ['(loop for x in xs', 'collect (foo x)', '(bar))'],
    ['(loop for x in xs', '      collect (foo x)', '              (bar))'],
  ],
  [
    'loop: of-type and simple type specs continue the for clause',
    ['(loop for i', 'of-type fixnum', 'from 0', 'for s', 'fixnum from 1', 'collect i)'],
    ['(loop for i', '        of-type fixnum', '        from 0', '      for s', '        fixnum from 1', '      collect i)'],
  ],
  [
    'feature expression alone on a line is the same argument as the form below it',
    ['(list 1', '#+sbcl', '2', '3)'],
    ['(list 1', '      #+sbcl', '      2', '      3)'],
  ],
  [
    'feature expression on a distinguished argument keeps the body at body indent',
    ['(let', '#+sbcl', '((x 1))', '(foo x))'],
    ['(let', '    #+sbcl', '    ((x 1))', '  (foo x))'],
  ],
  [
    'feature expression before a body form',
    ['(defun foo (x)', '#-sbcl', '(declare (ignore x))', '#+sbcl', '(bar x))'],
    ['(defun foo (x)', '  #-sbcl', '  (declare (ignore x))', '  #+sbcl', '  (bar x))'],
  ],
  [
    'feature expression with a compound test and a quoted form',
    ['(list', "#+(or sbcl ccl) 'fast", "#-(or sbcl ccl)", "'slow)"],
    ['(list', " #+(or sbcl ccl) 'fast", ' #-(or sbcl ccl)', " 'slow)"],
  ],
  [
    'loop: feature expression alone on a line before a clause',
    ['(loop for x in xs', '#+sbcl', 'do (print x)', 'collect x)'],
    ['(loop for x in xs', '      #+sbcl', '      do (print x)', '      collect x)'],
  ],
  [
    'loop: feature-prefixed clause keyword still introduces a body',
    ['(loop for x in xs', '#+sbcl do (print x)', '(print y)', 'collect x)'],
    ['(loop for x in xs', '      #+sbcl do (print x)', '                (print y)', '      collect x)'],
  ],
  [
    'lambda list with a feature-prefixed parameter on its own line',
    ['(defun foo (a', '#+sbcl', 'b', '&optional', 'c)', 'a)'],
    ['(defun foo (a', '            #+sbcl', '            b', '            &optional', '              c)', '  a)'],
  ],
  [
    'defmethod with qualifier',
    ['(defmethod foo :around ((x bar) y)', '(call-next-method))'],
    ['(defmethod foo :around ((x bar) y)', '  (call-next-method))'],
  ],
  [
    'defmethod lambda list on its own line is distinguished',
    ['(defmethod foo :around', '((x bar) y)', '(call-next-method))'],
    ['(defmethod foo :around', '    ((x bar) y)', '  (call-next-method))'],
  ],
  [
    'defmethod with (setf name)',
    ['(defmethod (setf foo) (value (x bar))', "(setf (slot-value x 'foo) value))"],
    ['(defmethod (setf foo) (value (x bar))', "  (setf (slot-value x 'foo) value))"],
  ],
  [
    'defclass slots, slot options, class options',
    [
      '(defclass point ()',
      '((x :initarg :x',
      ':accessor point-x)',
      '(default-y :initarg :y',
      ':accessor point-y))',
      '(:documentation "A point."))',
    ],
    [
      '(defclass point ()',
      '  ((x :initarg :x',
      '      :accessor point-x)',
      '   (default-y :initarg :y',
      '              :accessor point-y))',
      '  (:documentation "A point."))',
    ],
  ],
  [
    'defclass superclass list is data',
    ['(defclass c (a', 'b)', '())'],
    ['(defclass c (a', '             b)', '  ())'],
  ],
  [
    'defpackage with :export list',
    ['(defpackage #:foo', '(:use #:cl)', '(:export #:bar', '#:baz))'],
    ['(defpackage #:foo', '  (:use #:cl)', '  (:export #:bar', '           #:baz))'],
  ],
  [
    'keyword head aligns under its first argument',
    ['(:use :cl', ':alexandria)'],
    ['(:use :cl', '      :alexandria)'],
  ],
  [
    'lambda list with &key continuation',
    ['(defun foo (a b', '&key c d)', '(list a b c d))'],
    ['(defun foo (a b', '            &key c d)', '  (list a b c d))'],
  ],
  [
    'lambda lambda list and body',
    ['(lambda (a', '&optional b)', '(list a b))'],
    ['(lambda (a', '         &optional b)', '  (list a b))'],
  ],
  [
    "#'(lambda ...) ignores the prefix",
    ["#'(lambda (x)", '(foo x))'],
    ["#'(lambda (x)", '    (foo x))'],
  ],
  ['quoted data list', ["'(1 2", '3)'], ["'(1 2", '  3)']],
  ['vector literal', ['#(1 2', '3)'], ['#(1 2', '  3)']],
  [
    'backquote: body form shape',
    ['`(progn ,@body', ',result)'],
    ['`(progn ,@body', '   ,result)'],
  ],
  [
    'backquote: call shape aligns at the comma',
    ['`(foo ,@bar', ',baz)'],
    ['`(foo ,@bar', '      ,baz)'],
  ],
  [
    'multi-line string is left alone',
    ['(defun foo ()', '"line one', '   line two', 'line three")'],
    ['(defun foo ()', '  "line one', '   line two', 'line three")'],
  ],
  [
    'top-level block comment is left alone',
    ['#|', '   some text', '      more', '|#', '   (foo)'],
    ['#|', '   some text', '      more', '|#', '(foo)'],
  ],
  [
    'block comment inside a form: first line indents, rest untouched',
    ['(defun foo ()', '#| commented', '     out |#', '(bar))'],
    ['(defun foo ()', '  #| commented', '     out |#', '  (bar))'],
  ],
  [
    ';;; comments are left where they are',
    ['(defun foo ()', '   ;;; Section', '(bar))', ';;;; Header', '   (baz)'],
    ['(defun foo ()', '   ;;; Section', '  (bar))', ';;;; Header', '(baz)'],
  ],
  [
    'lambda list: parameters after &key align under the first one',
    ['(defun copy-array (array &key (element-type (array-element-type array))', '(fill-pointer nil)', '(adjustable nil))', '(foo))'],
    ['(defun copy-array (array &key (element-type (array-element-type array))', '                              (fill-pointer nil)', '                              (adjustable nil))', '  (foo))'],
  ],
  [
    'lambda list: a keyword that ends its line indents its parameters by 2',
    ['(defun foo (a &key', 'b c)', 'a)'],
    ['(defun foo (a &key', '                b c)', '  a)'],
  ],
  [
    'lambda list: a keyword on a new line aligns under the first keyword',
    ['(defun foo (a &optional b', '&key c)', 'a)'],
    ['(defun foo (a &optional b', '              &key c)', '  a)'],
  ],
  [
    'comma-prefixed form in a binding position is a call, not a binding list',
    ['`(let ,(mapcar (lambda (g n) (list g n))', 'gensyms names)', '(foo))'],
    ['`(let ,(mapcar (lambda (g n) (list g n))', '               gensyms names)', '   (foo))'],
  ],
  [
    'cond with clauses on their own lines indents them as a body',
    ['(cond', '((foo) 1)', '(t 2))'],
    ['(cond', '  ((foo) 1)', '  (t 2))'],
  ],
  [
    ';; comments indent like code',
    ['(defun foo ()', ';; comment', '(bar))'],
    ['(defun foo ()', '  ;; comment', '  (bar))'],
  ],
  [
    'blank lines stay blank and lose stray whitespace',
    ['(defun foo ()', '   ', '(bar))'],
    ['(defun foo ()', '', '  (bar))'],
  ],
  [
    'nested three deep: moving an outer line moves the inner ones',
    ['(defun foo ()', '      (let ((x 1))', '      (when x', '      (bar x))))'],
    ['(defun foo ()', '  (let ((x 1))', '    (when x', '      (bar x))))'],
  ],
  [
    'unclosed trailing form while typing',
    ['(defun foo ()', '(let ((x 1))'],
    ['(defun foo ()', '  (let ((x 1))'],
  ],
  [
    'handler-case clauses indent like local functions',
    ['(handler-case (foo)', '(error (e)', '(bar e)))'],
    ['(handler-case (foo)', '  (error (e)', '    (bar e)))'],
  ],
  [
    'unwind-protect: protected form distinguished, cleanup is body',
    ['(unwind-protect', '(foo)', '(bar))'],
    ['(unwind-protect', '    (foo)', '  (bar))'],
  ],
  [
    'multiple-value-bind',
    ['(multiple-value-bind (a b)', '(foo)', '(list a b))'],
    ['(multiple-value-bind (a b)', '    (foo)', '  (list a b))'],
  ],
  ['progn', ['(progn', '(foo)', '(bar))'], ['(progn', '  (foo)', '  (bar))']],
  ['plain call aligns under the first argument', ['(foo a', 'b)'], ['(foo a', '     b)']],
  ['plain call with no argument on the first line', ['(foo', 'bar)'], ['(foo', ' bar)']],
  ['in-package is a plain call', ['(in-package', ':foo)'], ['(in-package', ' :foo)']],
  ['defstruct with options list', ['(defstruct (point (:constructor make-pt))', 'x', 'y)'], ['(defstruct (point (:constructor make-pt))', '  x', '  y)']],
  [
    'define-condition',
    ['(define-condition my-error (error)', '((msg :initarg :msg))', '(:report "oops"))'],
    ['(define-condition my-error (error)', '  ((msg :initarg :msg))', '  (:report "oops"))'],
  ],
  ['tabs in leading whitespace become spaces', ['(defun foo ()', '\t(bar))'], ['(defun foo ()', '  (bar))']],
  ['top-level forms go to column 0', ['   (foo)', '  (bar)'], ['(foo)', '(bar)']],
  ['closing paren on its own line sits where the next element would', ['(foo', 'bar', ')'], ['(foo', ' bar', ' )']],
  ['declare is a plain call', ['(declare (optimize (speed 3)', '(safety 1)))'], ['(declare (optimize (speed 3)', '                   (safety 1)))']],
  [
    'def* heuristic for unknown definers: everything is body (Emacs lisp-indent-defform)',
    ['(deftest foo', '(bar)', '(baz))'],
    ['(deftest foo', '  (bar)', '  (baz))'],
  ],
  [
    'def* heuristic with the value on its own line',
    ['(defconst standard-type-symbols ; comment', "'(array", 'bignum)', '"Doc")'],
    ['(defconst standard-type-symbols ; comment', "  '(array", '    bignum)', '  "Doc")'],
  ],
  [
    'keyword head: body forms on following lines get the body indent (markup style)',
    ['(:section :class "featured"', '(:p :class "eyebrow" "x")', '(:ul', '(:li "a")', '(:li "b")))'],
    ['(:section :class "featured"', '  (:p :class "eyebrow" "x")', '  (:ul', '    (:li "a")', '    (:li "b")))'],
  ],
  [
    'keyword head: atoms on following lines align like a call',
    ['(:file "foo"', ':depends-on ("bar"))'],
    ['(:file "foo"', '       :depends-on ("bar"))'],
  ],
  [
    'comma-prefixed head is a plain call shape, not an operator',
    ['`(,fn ,a', ',b)', '`(,@default "msg"', ',value)'],
    ['`(,fn ,a', '      ,b)', '`(,@default "msg"', '            ,value)'],
  ],
  [
    'with-* heuristic for unknown macros',
    ['(with-transaction (db)', '(insert db))'],
    ['(with-transaction (db)', '  (insert db))'],
  ],
  [
    'unknown operator without heuristics is a plain call',
    ['(my-bind (x 1)', '(foo x))'],
    ['(my-bind (x 1)', '         (foo x))'],
  ],
  [
    'operatorArity from the workspace gives a body',
    ['(my-bind (x 1)', '(foo x))'],
    ['(my-bind (x 1)', '  (foo x))'],
    { ...defaultSettings(), operatorArity: (name) => (name === 'MY-BIND' ? 1 : undefined) },
  ],
  [
    'operatorArity -1 disables the def* heuristic',
    ['(default-value x', 'y)'],
    ['(default-value x', '               y)'],
    { ...defaultSettings(), operatorArity: (name) => (name === 'DEFAULT-VALUE' ? -1 : undefined) },
  ],
  [
    'user spec override adds distinguished arguments',
    ['(my-op foo', '(bar)', '(baz))'],
    ['(my-op foo', '    (bar)', '  (baz))'],
    { ...defaultSettings(), specs: new Map([...Object.entries(DEFAULT_SPECS), ['MY-OP', 2]]) },
  ],
  [
    'reader conditional prefix aligns at the #',
    ['(list #+sbcl 1', '#-sbcl 2)'],
    ['(list #+sbcl 1', '      #-sbcl 2)'],
  ],
  [
    'already correct text is unchanged',
    ['(defun foo (x)', '  (let ((y (* x 2)))', '    (list x y)))', '', ';;; end'],
    ['(defun foo (x)', '  (let ((y (* x 2)))', '    (list x y)))', '', ';;; end'],
  ],
];

for (const [name, input, expected, settings] of cases) {
  test(`reindent: ${name}`, () => {
    const actual = reindentText(input.join('\n'), settings ?? defaultSettings());
    assert.equal(actual, expected.join('\n'));
  });
}

test('reindent is idempotent on every case', () => {
  for (const [name, , expected, settings] of cases) {
    const text = expected.join('\n');
    assert.equal(reindentText(text, settings ?? defaultSettings()), text, name);
  }
});

test('indentationForLine: empty line inside an open let gets the body indent', () => {
  const result = parse('(let ((x 1))\n');
  assert.equal(indentationForLine(result, 1, defaultSettings()), 2);
});

test('indentationForLine: empty line inside an open defun lambda list position', () => {
  const result = parse('(defun foo\n');
  assert.equal(indentationForLine(result, 1, defaultSettings()), 4);
});

test('indentationForLine: top level is 0', () => {
  const result = parse('(foo)\n\n');
  assert.equal(indentationForLine(result, 1, defaultSettings()), 0);
  assert.equal(indentationForLine(result, 2, defaultSettings()), 0);
});

test('indentationForLine: null inside a multi-line string', () => {
  const result = parse('(foo "a\nb\nc")\n');
  assert.equal(indentationForLine(result, 1, defaultSettings()), null);
  assert.equal(indentationForLine(result, 2, defaultSettings()), null);
});

test('indentationForLine: null inside an unterminated string, even on the last empty line', () => {
  const result = parse('(foo "a\n');
  assert.equal(indentationForLine(result, 1, defaultSettings()), null);
});

test('indentationForLine: null inside a block comment, including its closing line', () => {
  const result = parse('(foo\n #| a\n  b\n |#\n (bar))\n');
  assert.equal(indentationForLine(result, 1, defaultSettings()), 1);
  assert.equal(indentationForLine(result, 2, defaultSettings()), null);
  assert.equal(indentationForLine(result, 3, defaultSettings()), null);
  assert.equal(indentationForLine(result, 4, defaultSettings()), 1);
});

test('indentationForLine: line out of range is null', () => {
  const result = parse('(foo)');
  assert.equal(indentationForLine(result, 5, defaultSettings()), null);
});

test('indentationForLine: loop clause position on a fresh line', () => {
  const result = parse('(loop for x in xs\n      when (foo x)\n');
  assert.equal(indentationForLine(result, 2, defaultSettings()), 8);
});

test('indentationForLine: fresh line after a feature expression alone on a line', () => {
  assert.equal(indentationForLine(parse('(list 1\n      #+sbcl\n'), 2, defaultSettings()), 6);
  assert.equal(indentationForLine(parse('(let\n    #+sbcl\n'), 2, defaultSettings()), 4);
});

test('indentationForLine: fresh line after a body keyword, after a body form, after a clause', () => {
  assert.equal(indentationForLine(parse('(loop for x in xs\n      do\n'), 2, defaultSettings()), 9);
  assert.equal(indentationForLine(parse('(loop for x in xs\n      do (print x)\n'), 2, defaultSettings()), 9);
  assert.equal(indentationForLine(parse('(loop for x in xs\n      collect x\n'), 2, defaultSettings()), 6);
  assert.equal(indentationForLine(parse('(loop\n'), 1, defaultSettings()), 2);
});

test('CRLF line endings are preserved', () => {
  assert.equal(reindentText('(defun foo ()\r\n(bar))\r\n'), '(defun foo ()\r\n  (bar))\r\n');
});

test('defaultSettings exposes the spec table as a Map', () => {
  const settings = defaultSettings();
  assert.equal(settings.specs.get('DEFUN'), 2);
  assert.equal(settings.specs.get('COND'), undefined);
  assert.equal(settings.bodyIndent, 2);
  assert.equal(settings.distinguishedIndent, 4);
});

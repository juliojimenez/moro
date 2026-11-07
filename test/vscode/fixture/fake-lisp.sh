#!/bin/sh
# Pretends to be a Lisp REPL: prints a banner, then records every line it is
# sent next to itself (sent.log) and echoes it back with a prompt.
log="$(dirname "$0")/sent.log"
: > "$log"
echo "FAKE-LISP ready"
while IFS= read -r line; do
  printf '%s\n' "$line" >> "$log"
  printf '* %s\n' "$line"
done

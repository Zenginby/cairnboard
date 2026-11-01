#!/bin/sh
# Interim leak gate (replaced by security/hook.mjs in milestone A0 task 5).
# Scans text on stdin against the private denylist in $CAIRN_DENYLIST; prints only line numbers.
fold() { tr 'A-ZÇĞIİÖŞÜ' 'a-zçğıiöşü' | sed 's/ç/c/g;s/ğ/g/g;s/ı/i/g;s/ö/o/g;s/ş/s/g;s/ü/u/g;s/â/a/g;s/î/i/g;s/û/u/g;s/[-_.\/]/ /g'; }
if [ -z "$CAIRN_DENYLIST" ] || [ ! -r "$CAIRN_DENYLIST" ]; then
  echo "commit blocked: denylist not configured (set CAIRN_DENYLIST)" >&2; exit 2
fi
TERMS=$(mktemp); trap 'rm -f "$TERMS"' EXIT
grep -v '^[[:space:]]*#' "$CAIRN_DENYLIST" | grep -v '^[[:space:]]*$' | fold > "$TERMS"
ALLOW="111437340+zenginby@users noreply github com"
HITS=$(fold | sed "s/$ALLOW//g" | grep -n -i -F -f "$TERMS" | cut -d: -f1 | tr '\n' ' ')
if [ -n "$HITS" ]; then echo "commit blocked: denylisted term on line(s) $HITS($1)" >&2; exit 1; fi

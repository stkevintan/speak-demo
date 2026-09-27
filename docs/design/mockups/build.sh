#!/usr/bin/env bash
# Render every UI mockup to docs/design/assets/*.png and run the layout self-check.
#
#   ./build.sh          render + check
#   ./build.sh --check  check only (fast, no PNGs)
#
# The mockups are fixed 1440x900 frames with overflow:hidden, so clipped content
# would otherwise pass unnoticed. _check.js reports anything outside the canvas
# into #__diag, which this script reads back via --dump-dom.

set -euo pipefail

CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
DIR="$(cd "$(dirname "$0")" && pwd)"
OUT="$DIR/../assets"
CHECK_ONLY="${1:-}"

[ -x "$CHROME" ] || { echo "Chrome not found at $CHROME" >&2; exit 1; }
mkdir -p "$OUT"

fail=0
for f in "$DIR"/[0-9]*.html; do
  base="$(basename "$f" .html)"

  diag="$("$CHROME" --headless=new --disable-gpu --virtual-time-budget=4000 \
    --dump-dom "file://$f" 2>/dev/null \
    | grep -o '<div id="__diag">[^<]*' | sed 's/.*>//' || true)"
  [ -n "$diag" ] || diag="NO DIAG (script did not run)"

  case "$diag" in
    OK*) status="ok   " ;;
    *)   status="FAIL "; fail=1 ;;
  esac
  printf '%s %-26s %s\n' "$status" "$base" "$diag"

  if [ "$CHECK_ONLY" != "--check" ]; then
    "$CHROME" --headless=new --disable-gpu --hide-scrollbars \
      --force-device-scale-factor=2 --window-size=1440,900 \
      --virtual-time-budget=4000 \
      --screenshot="$OUT/$base.png" "file://$f" 2>/dev/null
  fi
done

if [ "$CHECK_ONLY" != "--check" ]; then
  echo
  echo "Wrote $(ls "$OUT"/*.png 2>/dev/null | wc -l | tr -d ' ') snapshots to $OUT"
fi
exit $fail

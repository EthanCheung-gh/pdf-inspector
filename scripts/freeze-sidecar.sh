#!/bin/sh
# Freeze the Python sidecar into a single-file binary with PyInstaller.
set -e
cd "$(dirname "$0")/../sidecar"

# Resolve a working Python command (mirrors python-resolver.ts candidate order).
PYTHON=""
for candidate in "python3" "py -3" "python"; do
  if $candidate --version >/dev/null 2>&1; then
    PYTHON="$candidate"
    break
  fi
done
if [ -z "$PYTHON" ]; then
  echo "error: no working Python found (tried: python3, py -3, python)" >&2
  exit 1
fi

OUT_DIR="../dist-sidecar"
rm -rf "$OUT_DIR" build dist

$PYTHON -m PyInstaller \
  --onefile \
  --name pdf-inspector-sidecar \
  --collect-all pdfminer \
  --collect-all pypdfium2 \
  --collect-all PIL \
  --distpath "$OUT_DIR" \
  --workpath build \
  --specpath build \
  main.py

echo "Frozen sidecar written to $OUT_DIR"

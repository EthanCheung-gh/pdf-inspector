#!/bin/sh
# Freeze the Python sidecar into a single-file binary with PyInstaller.
set -e

# Resolve a working Python command (mirrors python-resolver.ts candidate order).
# An explicit PYTHON (for example `.venv/bin/python` locally or the `python`
# installed by actions/setup-python in CI) wins when it actually runs; otherwise
# fall back to probing the usual candidates.
# Resolution happens before entering sidecar/ so a relative interpreter path is
# relative to the invocation directory (npm runs from the repo root).
INVOCATION_DIR=$(pwd)
PYTHON_BIN=""
if [ -n "${PYTHON:-}" ]; then
  case "$PYTHON" in
    /*) explicit_python="$PYTHON" ;;
    [A-Za-z]:*) explicit_python="$PYTHON" ;;  # Windows absolute path (Git Bash)
    */*) explicit_python="$INVOCATION_DIR/$PYTHON" ;;
    *) explicit_python="$PYTHON" ;;
  esac
  if $explicit_python --version >/dev/null 2>&1; then
    PYTHON_BIN="$explicit_python"
  fi
fi
if [ -z "$PYTHON_BIN" ]; then
  for candidate in "python3" "py -3" "python"; do
    if $candidate --version >/dev/null 2>&1; then
      PYTHON_BIN="$candidate"
      break
    fi
  done
fi
if [ -z "$PYTHON_BIN" ]; then
  echo "error: no working Python found (tried: ${PYTHON:+\$PYTHON, }python3, py -3, python)" >&2
  exit 1
fi

cd "$(dirname "$0")/../sidecar"

OUT_DIR="../dist-sidecar"
rm -rf "$OUT_DIR" build dist

$PYTHON_BIN -m PyInstaller \
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

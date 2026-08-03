# PDF Inspector — Packaging & Distribution Design

**Date:** 2026-08-03
**Status:** Draft
**Author:** Superpowers spec process (brainstorming → spec)

---

## 1. Overview

Package PDF Inspector as installable desktop applications for Windows, macOS, and Linux. The Python sidecar (pdfplumber/Pillow) is frozen into a single-file native binary with PyInstaller per platform and shipped inside the app via electron-builder's `extraResources`, so end users need no Python installation. Each platform produces an installer plus a portable/green build. No code signing, no auto-update.

## 2. Goals / Non-Goals

**Goals:**
- `electron-builder.yml` producing: Windows NSIS installer + portable exe; Linux AppImage + deb; macOS dmg (built on a macOS host).
- PyInstaller freeze pipeline (`scripts/freeze-sidecar.sh`) producing `dist-sidecar/pdf-inspector-sidecar[.exe]` per platform, with pdfplumber's transitive deps (`pdfminer`, `pypdfium2`, `Pillow`) collected.
- Main process spawns the frozen binary when packaged (`app.isPackaged`), keeps the current `python3`/`py -3` resolution in development.
- Startup validation in packaged mode: missing/non-executable sidecar binary shows a clear error instead of a silent spawn failure.
- `docs/packaging.md`: per-platform prerequisites and build commands.
- A 512×512 app icon (`build/icon.png`) required by NSIS/dmg/AppImage.

**Non-Goals:**
- CI/CD pipeline (local builds only this phase).
- Code signing, notarization, auto-update.
- Cross-compilation (each platform builds on its native host).
- Installer customization beyond defaults (custom NSIS pages, license files).

## 3. User Decisions (locked)

| Question | Decision |
|----------|----------|
| Target platforms | Windows + macOS + Linux |
| Python runtime distribution | PyInstaller-frozen sidecar binary |
| Package formats | Installer + portable/green per platform |
| Signing / auto-update | Neither |

## 4. Architecture

### 4.1 Build pipeline (per platform, on its native host)

```
npm run build            # tsc + vite: renderer, main, preload → dist/
npm run freeze:sidecar   # PyInstaller → dist-sidecar/pdf-inspector-sidecar[.exe]
npm run dist             # electron-builder → release/
```

### 4.2 Sidecar spawn resolution

`SidecarManager` currently spawns `resolvePythonCommand()` + `sidecar/main.py`. A new pure function `resolveSidecarCommand()` decides the spawn target:

- **Packaged** (`app.isPackaged === true`): `{ command: <resourcesPath>/sidecar/pdf-inspector-sidecar[.exe], args: [] }`. The binary name is `pdf-inspector-sidecar.exe` on Windows, `pdf-inspector-sidecar` elsewhere.
- **Development**: existing behavior — `{ command: pythonCmd, args: [SIDECAR_SCRIPT] }` from `python-resolver.ts`.

The function takes its inputs (isPackaged, resourcesPath, platform) as parameters so it is unit-testable without Electron; `sidecar.ts` wires real values at the call site. The stdio JSON-RPC protocol is identical in both modes.

### 4.3 electron-builder packaging

`electron-builder.yml` drives everything; `dist-sidecar/` contents are mapped into the app's `resources/sidecar/` via `extraResources`. The renderer/main/preload bundles in `dist/` are the app `files`.

## 5. Components

### 5.1 New file: `electron-builder.yml`

```yaml
appId: com.ethancheung.pdfinspector
productName: PDF Inspector
directories:
  output: release
files:
  - dist/**
  - package.json
extraResources:
  - from: dist-sidecar
    to: sidecar
    filter:
      - pdf-inspector-sidecar
      - pdf-inspector-sidecar.exe
win:
  target:
    - nsis
    - portable
  icon: build/icon.png
nsis:
  oneClick: false
  allowToChangeInstallationDirectory: true
  shortcutName: PDF Inspector
linux:
  target:
    - AppImage
    - deb
  icon: build/icon.png
  category: Office
mac:
  target:
    - dmg
  icon: build/icon.png
  category: public.app-category.productivity
```

### 5.2 New file: `scripts/freeze-sidecar.sh`

POSIX shell script (run via Git Bash on Windows):

```sh
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
```

Prerequisite (documented in `docs/packaging.md`): `pip install pyinstaller` plus `pip install -r sidecar/requirements.txt` in the build environment. On Windows the script runs under Git Bash; the Python candidate fallback (`python3` → `py -3` → `python`) mirrors `python-resolver.ts`.

### 5.3 Modified: `src/main/sidecar.ts`

- Add `resolveSidecarCommand(opts: { isPackaged: boolean; resourcesPath: string; platform: NodeJS.Platform }): { command: string; args: string[] }` as an exported pure function.
- `SidecarManager.start()` calls it with real values (`app.isPackaged`, `process.resourcesPath`, `process.platform`) instead of directly using `resolvePythonCommand()` + `SIDECAR_SCRIPT`.
- Packaged mode additionally checks `fs.existsSync(command)`; on failure it records a startup error (`Sidecar binary missing at <path>. Reinstall the application.`) surfaced through the existing sidecar-status/error path, and does not attempt spawn.

### 5.4 New test: `src/main/__tests__/sidecar-command.test.ts`

Vitest unit tests for `resolveSidecarCommand`:

- packaged + `win32` → command ends with `sidecar/pdf-inspector-sidecar.exe`, args `[]`
- packaged + `linux`/`darwin` → command ends with `sidecar/pdf-inspector-sidecar`, args `[]`
- development + `linux`/`darwin` → command `python3`, args `[sidecar/main.py]`
- development + `win32` → command is one of the resolver candidates, args `[sidecar/main.py]`

(Development-mode assertions mock `resolvePythonCommand` via `vi.mock` on `../shared/python-resolver`.)

### 5.5 Modified: `package.json`

New scripts:

```json
"freeze:sidecar": "sh scripts/freeze-sidecar.sh",
"dist": "npm run build && electron-builder",
"dist:win": "npm run build && electron-builder --win",
"dist:mac": "npm run build && electron-builder --mac",
"dist:linux": "npm run build && electron-builder --linux"
```

### 5.6 New file: `build/icon.png`

512×512 PNG app icon: a simple, flat design (document/magnifier motif on a solid background). Generated once and committed; no design tooling required at build time.

### 5.7 New file: `docs/packaging.md`

Per-platform build guide: prerequisites (Node 20+, Python 3.10+ with `pip install -r sidecar/requirements.txt pyinstaller`, platform tools — Windows: none extra; Linux: `fuse` for AppImage; macOS: Xcode CLT), the three-command pipeline, output locations (`release/`), and the clean-machine verification checklist.

## 6. Data Flow

Packaged app start: `main` creates `SidecarManager` → `resolveSidecarCommand({isPackaged: true, ...})` → binary path under `process.resourcesPath/sidecar/` → existence check → spawn → existing readiness probe (`sidecar-status`) → renderer unchanged.

## 7. Error Handling

- Missing frozen binary (packaged): startup error string recorded and shown via the existing StatusBar/error path; no spawn attempt, no retry loop.
- Frozen binary crashes at runtime: existing restart-with-budget logic applies unchanged (restart spawns the same resolved command again).
- `freeze-sidecar.sh` fails (no PyInstaller, missing deps): non-zero exit with the PyInstaller error; `npm run dist` is not chained to it, so the failure surface is explicit.
- Unknown `platform` value in `resolveSidecarCommand`: falls back to the non-`.exe` binary name and logs a warning.

## 8. Testing

- `sidecar-command.test.ts` per §5.4 (vitest, `vi.mock` for the python resolver in dev-mode cases).
- Build validation on the dev machine: `npm run freeze:sidecar` produces a binary that starts and stays alive awaiting stdin (no immediate exit or Python traceback), and `npm run dist:linux` produces AppImage + deb in `release/`.
- Manual verification (per platform, as hosts are available): install on a machine WITHOUT Python → launch → open PDF → extraction/search/export work; portable build runs without install.

## 9. File Structure

**New files**

| File | Purpose |
|------|---------|
| `electron-builder.yml` | electron-builder configuration |
| `scripts/freeze-sidecar.sh` | PyInstaller freeze pipeline |
| `src/main/__tests__/sidecar-command.test.ts` | resolveSidecarCommand unit tests |
| `build/icon.png` | 512×512 app icon |
| `docs/packaging.md` | Per-platform build guide |

**Modified files**

| File | Changes |
|------|---------|
| `src/main/sidecar.ts` | `resolveSidecarCommand()` + packaged spawn + existence check |
| `package.json` | freeze/dist scripts |

**Untouched:** renderer, preload, shared constants, sidecar Python code, IPC protocol.

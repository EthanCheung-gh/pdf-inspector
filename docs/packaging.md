# Packaging PDF Inspector

Produces installers + portable builds for Windows, macOS, Linux. The Python
sidecar is frozen with PyInstaller, so end users need no Python.

Each platform must be built on its native host (PyInstaller cannot
cross-compile; macOS packages require a macOS host).

## Prerequisites (all platforms)

- Node.js 20+ and npm dependencies installed (`npm ci`)
- Python 3.10+ available as `python3` (Linux/macOS) or `py -3` / `python` (Windows, Git Bash)
- Python packages: `pip install -r sidecar/requirements.txt pyinstaller`

Platform extras:

- **Windows**: run the commands in Git Bash (bundled with Git for Windows).
- **Linux**: `fuse` (or `libfuse2`) for AppImage tooling; `dpkg` for the deb target.
- **macOS**: Xcode Command Line Tools.

## Build

```sh
npm run build            # 1. renderer + main + preload → dist/
npm run freeze:sidecar   # 2. PyInstaller → dist-sidecar/
npm run dist             # 3. electron-builder → release/ (current platform)
```

Per-platform shortcuts: `npm run dist:win` / `npm run dist:mac` / `npm run dist:linux`
(each includes step 1; still run `freeze:sidecar` first on the same host).

## Outputs

| Platform | Artifacts (in `release/`) |
|----------|---------------------------|
| Windows  | NSIS installer `.exe`, portable `.exe` |
| Linux    | `.AppImage`, `.deb` |
| macOS    | `.dmg` |

## Verify on a clean machine

1. Use a machine/VM **without** Python installed.
2. Install (or run the portable build) and launch PDF Inspector.
3. Open a PDF → page renders, object extraction populates the tree.
4. Search (Ctrl+F) and Export (all four combinations) work.

If the app reports "Sidecar binary missing", the package was built without
running `npm run freeze:sidecar` first — rebuild including step 2.

# Packaging PDF Inspector

Produces installers + portable builds for Windows, macOS, Linux. The Python
sidecar is frozen with PyInstaller, so end users need no Python.

Each platform must be built on its native host (PyInstaller cannot
cross-compile; macOS packages require a macOS host).

## Prerequisites (all platforms)

- Node.js 20+ and npm dependencies installed (`npm ci`)
- Python 3.10+ available as `python3` (Linux/macOS) or `py -3` / `python` (Windows, Git Bash)
- Python packages: `pip install -r sidecar/requirements.txt pyinstaller`

To use a specific interpreter (for example `.venv/bin/python` with PyInstaller
installed in that virtualenv), set `PYTHON`. The freeze script uses it when it
works and otherwise keeps the `python3` / `py -3` / `python` fallback:

```sh
PYTHON=.venv/bin/python npm run freeze:sidecar
```

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

All `dist*` scripts pass `--publish never`, so electron-builder only writes files
into `release/`. Publication is handled exclusively by the release workflow's
`publish` job (`softprops/action-gh-release`); local builds never upload.

## Outputs

| Platform | Artifacts (in `release/`) |
|----------|---------------------------|
| Windows  | NSIS installer `.exe`, portable `.exe` |
| Linux    | `.AppImage`, `.deb` |
| macOS    | `.dmg` |

## Linux packages run Electron with `--no-sandbox`

Linux builds set `linux.executableArgs: ["--no-sandbox"]` in
[`electron-builder.yml`](../electron-builder.yml), so the generated launchers
start Electron without the Chromium sandbox.

Reason: the install prefix is derived from the product name, which contains a
space (`/opt/PDF Inspector`). Chromium's zygote helper cannot `execvp` a path
containing spaces, so a sandboxed launch dies with
`LaunchProcess: failed to execvp: /opt/PDF` followed by
`FATAL:zygote_host_impl_linux.cc(201) Check failed: Invalid argument (22)`.
Passing `--no-sandbox` avoids the zygote re-exec entirely.

The deb desktop entry therefore contains:

```
Exec="/opt/PDF Inspector/pdf-inspector" --no-sandbox %U
```

This is a packaging-level flag only — no application code is involved. The
AppImage target already passed `--no-sandbox` by default (electron-builder's
fallback when `executableArgs` is unset); declaring it explicitly keeps both
Linux targets identical and makes the deb desktop entry work when launched from
the desktop environment or directly.

### deb launcher wrapper (`scripts/deb-after-install.sh`)

The desktop entry alone is not enough on desktops that cache it. GNOME Shell
keeps the entry it first saw, so after upgrading from a build whose `Exec` had
no flag, the shell re-launches `/opt/PDF Inspector/pdf-inspector` **without**
`--no-sandbox` and the zygote crash above returns — the entry on disk already
contains the flag, but the shell never re-reads it.

To make such stale `Exec` lines work, `deb.afterInstall` points at
[`scripts/deb-after-install.sh`](../scripts/deb-after-install.sh), which on every
install/upgrade/reinstall:

1. moves the real Electron binary `/opt/PDF Inspector/pdf-inspector` to
   `/opt/PDF Inspector/pdf-inspector-bin` (mode preserved);
2. writes a POSIX `sh` wrapper at `/opt/PDF Inspector/pdf-inspector` (mode 755)
   that always appends the flag:
   ```sh
   exec "/opt/PDF Inspector/pdf-inspector-bin" --no-sandbox "$@"
   ```

So whichever form of the path a launcher uses — the desktop entry, the
`update-alternatives` link in `/usr/bin/pdf-inspector`, or a hand-typed command
— Electron always starts unsandboxed. Arguments are forwarded, so `%U` file
arguments still reach the app.

`electron-builder` has a single post-install hook: setting `deb.afterInstall`
**replaces** its `templates/linux/after-install.tpl`. The script therefore
reproduces that template's logic verbatim before adding the wrapper —
`update-alternatives` registration of `/usr/bin/pdf-inspector`, the SUID bit on
`chrome-sandbox`, and the `update-mime-database` / `update-desktop-database`
refreshes — so the custom hook is additive, not a replacement of that behaviour.

The script is idempotent: if `pdf-inspector` is already the wrapper it is left
untouched (it is never overwritten with itself or made to recurse), and a
missing `pdf-inspector-bin`, a `pdf-inspector-bin` that is not an executable, or
a launcher that is neither the wrapper nor an ELF binary aborts the postinst with
a clear message instead of installing a broken launcher.

## Release workflow (GitHub Actions)

[`.github/workflows/release.yml`](../.github/workflows/release.yml) builds the
packages on native runners and publishes them as a GitHub release. Publishing is
tag-driven:

```sh
# 1. Bump "version" in package.json and package-lock.json, then commit.
# 2. Tag the commit and push the tag:
git tag v0.3.3
git push origin v0.3.3
```

Pushing a `v*` tag starts the workflow. The tag name becomes the release tag, so
keep it in sync with `version` in `package.json` (currently `0.3.3`).

The build job matrix is `ubuntu-latest`, `windows-latest`, and
`macos-latest` with `fail-fast: false` and a 45-minute timeout. Each runner
checks out the repo, installs Node from `.nvmrc` and Python 3.12, runs
`npm ci` (with the Electron binary), installs `sidecar/requirements.txt` plus
`pyinstaller`, then runs `npm run build`, `npm run freeze:sidecar`, and
`npm run dist`. On Windows the freeze step runs under Git Bash (`shell: bash`)
so the POSIX script can execute. The sidecar step also sets `PYTHON: python` to
pin the interpreter that `actions/setup-python` installed.

Platform constraints still apply:

- Each target is built on its own native host; PyInstaller cannot cross-compile
  and macOS packages require a macOS runner.
- macOS packages are **unsigned** (and not notarized) because CI has no
  Developer ID certificate. `CSC_IDENTITY_AUTO_DISCOVERY: false` stops
  electron-builder from searching for a signing identity. Users must bypass
  Gatekeeper (right-click → Open) until signing is added.

Each matrix job uploads only its own platform's files as a workflow artifact:

| Runner | Uploaded artifacts |
|--------|--------------------|
| `ubuntu-latest` | `release/*.AppImage`, `release/*.deb` |
| `windows-latest` | `release/*.exe` |
| `macos-latest` | `release/*.dmg` |

A single `publish` job (`needs: build`, Ubuntu, `contents: write`) downloads all
artifacts with `merge-multiple: true` into `release-assets/` and calls
`softprops/action-gh-release@v2` once. Only this job creates the release, so the
matrix jobs cannot race to create it; the release is named
`PDF Inspector <tag>`, uses generated release notes, is marked latest, and
attaches the merged `.AppImage` / `.deb` / `.exe` / `.dmg` files.
`fail_on_unmatched_files: false` is expected because each build only produces
its own platform's assets.

`workflow_dispatch` is available for packaging smoke tests: it runs the build
matrix and uploads artifacts, but the `publish` job is skipped unless the ref is
a tag, so no release is created from a branch.

## Verify on a clean machine

1. Use a machine/VM **without** Python installed.
2. Install (or run the portable build) and launch PDF Inspector.
3. Open a PDF → page renders, object extraction populates the tree.
4. Search (Ctrl+F) and Export (all four combinations) work.

If the app reports "Sidecar binary missing", the package was built without
running `npm run freeze:sidecar` first — rebuild including step 2.

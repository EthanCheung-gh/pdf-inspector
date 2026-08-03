# Packaging & Distribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-subagent-driven-development (recommended) or superpowers-executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Package PDF Inspector for Windows/macOS/Linux with a PyInstaller-frozen sidecar binary (no end-user Python), per `docs/superpowers/specs/2026-08-03-packaging-design.md`.

**Architecture:** A pure `resolveSidecarCommand()` in `sidecar.ts` picks the spawn target (packaged → frozen binary under `resourcesPath/sidecar/`; dev → existing python resolution + `sidecar/main.py`). Build pipeline: `npm run build` → `scripts/freeze-sidecar.sh` (PyInstaller onefile) → `electron-builder` with `extraResources`. Icon is generated deterministically by a Node script (no binary assets hand-made).

**Tech Stack:** electron-builder 24, PyInstaller, TypeScript 5.5+, Vitest 2, Node 20+.

---

## File Structure — New Files

| File | Purpose |
|------|---------|
| `src/main/__tests__/sidecar-command.test.ts` | Unit tests for resolveSidecarCommand |
| `electron-builder.yml` | electron-builder configuration |
| `scripts/generate-icon.js` | Deterministic 512×512 PNG icon generator (Node, zero deps) |
| `build/icon.png` | Generated app icon (committed) |
| `scripts/freeze-sidecar.sh` | PyInstaller freeze pipeline |
| `docs/packaging.md` | Per-platform build guide |

## File Structure — Modified Files

| File | Changes |
|------|---------|
| `src/main/sidecar.ts` | Add `resolveSidecarCommand()`; `start()` uses it + packaged existence check |
| `package.json` | `freeze:sidecar` / `icon` / `dist*` scripts |

---

### Task 1: `resolveSidecarCommand` pure function with tests

**Files:**
- Modify: `src/main/sidecar.ts`
- Test: `src/main/__tests__/sidecar-command.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/main/__tests__/sidecar-command.test.ts`:

```typescript
import * as path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolvePythonCommand } from '../../shared/python-resolver';
import { resolveSidecarCommand } from '../sidecar';

vi.mock('../../shared/python-resolver', () => ({
  resolvePythonCommand: vi.fn(),
}));

const mockedResolve = vi.mocked(resolvePythonCommand);

describe('resolveSidecarCommand — packaged', () => {
  it('win32 uses the .exe binary with no args', () => {
    const result = resolveSidecarCommand({
      isPackaged: true,
      resourcesPath: '/app/resources',
      platform: 'win32',
    });
    expect(result.command).toBe(
      path.join('/app/resources', 'sidecar', 'pdf-inspector-sidecar.exe'),
    );
    expect(result.args).toEqual([]);
  });

  it.each(['linux', 'darwin'] as const)('%s uses the extension-less binary', (platform) => {
    const result = resolveSidecarCommand({
      isPackaged: true,
      resourcesPath: '/app/resources',
      platform,
    });
    expect(result.command).toBe(
      path.join('/app/resources', 'sidecar', 'pdf-inspector-sidecar'),
    );
    expect(result.args).toEqual([]);
  });

  it('unknown platform falls back to the non-.exe name', () => {
    const result = resolveSidecarCommand({
      isPackaged: true,
      resourcesPath: '/app/resources',
      platform: 'freebsd' as NodeJS.Platform,
    });
    expect(result.command.endsWith('pdf-inspector-sidecar')).toBe(true);
    expect(result.command.endsWith('.exe')).toBe(false);
  });
});

describe('resolveSidecarCommand — development', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('linux/mac: python3 + sidecar/main.py', () => {
    mockedResolve.mockReturnValue({ command: 'python3', args: [] });
    const result = resolveSidecarCommand({
      isPackaged: false,
      resourcesPath: '',
      platform: 'linux',
    });
    expect(result.command).toBe('python3');
    expect(result.args).toHaveLength(1);
    expect(result.args[0].endsWith(path.join('sidecar', 'main.py'))).toBe(true);
  });

  it('win32: resolver candidate + args + sidecar/main.py', () => {
    mockedResolve.mockReturnValue({ command: 'py', args: ['-3'] });
    const result = resolveSidecarCommand({
      isPackaged: false,
      resourcesPath: '',
      platform: 'win32',
    });
    expect(result.command).toBe('py');
    expect(result.args).toHaveLength(2);
    expect(result.args[0]).toBe('-3');
    expect(result.args[1].endsWith(path.join('sidecar', 'main.py'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/__tests__/sidecar-command.test.ts`
Expected: FAIL — `resolveSidecarCommand is not a function` (or module load error if electron import breaks — if so, see the note in Step 3).

- [ ] **Step 3: Add the pure function to sidecar.ts**

In `src/main/sidecar.ts`, add after the imports (the file already imports `path`, `fs`, and `resolvePythonCommand`):

```typescript
export interface SidecarCommandOptions {
  isPackaged: boolean;
  resourcesPath: string;
  platform: NodeJS.Platform;
}

/**
 * Decide what to spawn for the sidecar.
 * Packaged: the PyInstaller-frozen binary shipped under resourcesPath/sidecar/.
 * Development: the resolved Python command + sidecar/main.py (prefers the
 * repo layout, falls back to the resources layout — caller validates).
 */
export function resolveSidecarCommand(opts: SidecarCommandOptions): {
  command: string;
  args: string[];
} {
  if (opts.isPackaged) {
    if (opts.platform !== 'win32' && opts.platform !== 'linux' && opts.platform !== 'darwin') {
      console.warn(`[sidecar] Unknown platform "${opts.platform}"; using non-Windows binary name`);
    }
    const binary = opts.platform === 'win32' ? 'pdf-inspector-sidecar.exe' : 'pdf-inspector-sidecar';
    return { command: path.join(opts.resourcesPath, 'sidecar', binary), args: [] };
  }

  const devScript = path.join(__dirname, '../../sidecar/main.py');
  const bundledScript = path.join(opts.resourcesPath, 'sidecar/main.py');
  const scriptPath = fs.existsSync(devScript)
    ? devScript
    : fs.existsSync(bundledScript)
      ? bundledScript
      : devScript; // caller validates existence and reports the error
  const { command, args } = resolvePythonCommand();
  return { command, args: [...args, scriptPath] };
}
```

Note for the implementer: `sidecar.ts` does NOT import electron yet — Task 2 adds that import. If the vitest run in Step 2/4 fails because importing `sidecar.ts` pulls in `electron`, that's expected only AFTER Task 2; at this point no electron import exists, so the test must pass cleanly.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/__tests__/sidecar-command.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/sidecar.ts src/main/__tests__/sidecar-command.test.ts
git commit -m "feat: add resolveSidecarCommand for packaged/dev spawn targets"
```

---

### Task 2: Wire `resolveSidecarCommand` into `SidecarManager.start()`

**Files:**
- Modify: `src/main/sidecar.ts`

- [ ] **Step 1: Add the electron import**

In `src/main/sidecar.ts`, add at the top with the other imports:

```typescript
import { app } from 'electron';
```

- [ ] **Step 2: Replace the spawn-target resolution in start()**

In `src/main/sidecar.ts`, replace this block (currently lines 83–95):

```typescript
    // Resolve sidecar script path
    let scriptPath: string;
    if (fs.existsSync(path.join(__dirname, '../../sidecar/main.py'))) {
      scriptPath = path.join(__dirname, '../../sidecar/main.py');
    } else if (process.resourcesPath && fs.existsSync(path.join(process.resourcesPath, 'sidecar/main.py'))) {
      scriptPath = path.join(process.resourcesPath, 'sidecar/main.py');
    } else {
      throw new Error('Cannot find sidecar/main.py');
    }

    return new Promise((resolve, reject) => {
      const { command, args } = resolvePythonCommand();
      const proc = spawn(command, [...args, scriptPath], {
```

with:

```typescript
    const isPackaged = app.isPackaged;
    const { command, args } = resolveSidecarCommand({
      isPackaged,
      resourcesPath: process.resourcesPath ?? '',
      platform: process.platform,
    });

    if (isPackaged) {
      if (!fs.existsSync(command)) {
        throw new Error(`Sidecar binary missing at ${command}. Reinstall the application.`);
      }
    } else {
      const scriptPath = args[args.length - 1];
      if (!fs.existsSync(scriptPath)) {
        throw new Error('Cannot find sidecar/main.py');
      }
    }

    return new Promise((resolve, reject) => {
      const proc = spawn(command, args, {
```

- [ ] **Step 3: Verify build and tests**

Run: `npx tsc -b && npx vitest run`
Expected: no type errors; all tests pass (66 existing + 6 new = 72).

- [ ] **Step 4: Smoke-test dev mode still works**

Run: `npm start` — the app must launch and the sidecar must connect (StatusBar shows "Sidecar connected"). Open a PDF and confirm extraction works. Close the app.
Expected: unchanged dev behavior.

- [ ] **Step 5: Commit**

```bash
git add src/main/sidecar.ts
git commit -m "feat: spawn frozen sidecar binary when packaged"
```

---

### Task 3: `electron-builder.yml` + package.json scripts

**Files:**
- Create: `electron-builder.yml`
- Modify: `package.json`

- [ ] **Step 1: Create electron-builder.yml**

Create `electron-builder.yml` in the repo root (content per spec §5.1):

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

- [ ] **Step 2: Add scripts to package.json**

In `package.json`, add to `"scripts"` (after `"preview"`):

```json
    "icon": "node scripts/generate-icon.js",
    "freeze:sidecar": "sh scripts/freeze-sidecar.sh",
    "dist": "npm run build && electron-builder",
    "dist:win": "npm run build && electron-builder --win",
    "dist:mac": "npm run build && electron-builder --mac",
    "dist:linux": "npm run build && electron-builder --linux"
```

- [ ] **Step 3: Validate the YAML parses**

Run: `node -e "console.log(Object.keys(require('js-yaml') ? {} : {}))" 2>/dev/null; npx electron-builder --help > /dev/null && echo electron-builder-ok`
Expected: `electron-builder-ok` (config is validated for real in Task 7 when electron-builder runs).

- [ ] **Step 4: Commit**

```bash
git add electron-builder.yml package.json
git commit -m "build: add electron-builder config and dist scripts"
```

---

### Task 4: App icon generator + `build/icon.png`

**Files:**
- Create: `scripts/generate-icon.js`
- Create: `build/icon.png` (generated, then committed)

A hand-drawn 512×512 PNG with zero dependencies: flat indigo rounded square, white document glyph, amber magnifier. Raw pixels → zlib → PNG chunks.

- [ ] **Step 1: Create the generator**

Create `scripts/generate-icon.js`:

```javascript
#!/usr/bin/env node
/**
 * Generate build/icon.png (512x512) deterministically — no dependencies.
 * Flat indigo rounded square + white document + amber magnifier.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 512;

// CRC32 table for PNG chunks
const crcTable = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c;
}
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

// ---------- pixel painting ----------
const px = new Uint8Array(SIZE * SIZE * 4); // RGBA

function setPx(x, y, r, g, b, a = 255) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
  const i = (y * SIZE + x) * 4;
  px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
}

function fillRoundedRect(x0, y0, x1, y1, radius, [r, g, b]) {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const cx = Math.max(x0 + radius, Math.min(x, x1 - radius - 1));
      const cy = Math.max(y0 + radius, Math.min(y, y1 - radius - 1));
      if ((x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2) setPx(x, y, r, g, b);
    }
  }
}

function fillRect(x0, y0, x1, y1, [r, g, b]) {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) setPx(x, y, r, g, b);
}

function fillCircle(cx, cy, radius, [r, g, b]) {
  for (let y = cy - radius; y <= cy + radius; y++) {
    for (let x = cx - radius; x <= cx + radius; x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2) setPx(x, y, r, g, b);
    }
  }
}

function strokeCircle(cx, cy, radius, thickness, color) {
  for (let y = cy - radius - 1; y <= cy + radius + 1; y++) {
    for (let x = cx - radius - 1; x <= cx + radius + 1; x++) {
      const d = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
      if (Math.abs(d - radius) <= thickness / 2) setPx(x, y, ...color);
    }
  }
}

function strokeLine(x0, y0, x1, y1, thickness, color) {
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) * 2;
  for (let i = 0; i <= steps; i++) {
    const x = Math.round(x0 + ((x1 - x0) * i) / steps);
    const y = Math.round(y0 + ((y1 - y0) * i) / steps);
    fillCircle(x, y, Math.ceil(thickness / 2), color);
  }
}

// Background: indigo rounded square with margin
fillRoundedRect(16, 16, SIZE - 16, SIZE - 16, 96, [79, 70, 229]);

// Document: white sheet with folded corner
const DOC = { x0: 156, y0: 116, x1: 326, y1: 396, fold: 40 };
fillRect(DOC.x0, DOC.y0 + DOC.fold, DOC.x1, DOC.y1, [248, 250, 252]);
fillRect(DOC.x0, DOC.y0, DOC.x1 - DOC.fold, DOC.y0 + DOC.fold, [248, 250, 252]);
// fold triangle (darker)
for (let i = 0; i < DOC.fold; i++) {
  for (let j = 0; j <= i; j++) {
    setPx(DOC.x1 - DOC.fold + j, DOC.y0 + i, 203, 213, 225);
  }
}
// text lines
for (let row = 0; row < 5; row++) {
  const y = DOC.y0 + 80 + row * 44;
  const w = row === 4 ? 90 : 130;
  fillRect(DOC.x0 + 24, y, DOC.x0 + 24 + w, y + 14, [148, 163, 184]);
}

// Magnifier: amber ring + handle, overlapping document bottom-right
const MAG = { cx: 330, cy: 330, r: 78, t: 26 };
strokeCircle(MAG.cx, MAG.cy, MAG.r, MAG.t, [245, 158, 11]);
strokeLine(MAG.cx + 58, MAG.cy + 58, MAG.cx + 118, MAG.cy + 118, 30, [245, 158, 11]);

// ---------- PNG encoding ----------
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0; // filter: none
  px.subarray
    ? raw.set(px.subarray(y * SIZE * 4, (y + 1) * SIZE * 4), y * (SIZE * 4 + 1) + 1)
    : null;
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;  // bit depth
ihdr[9] = 6;  // color type RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const outPath = path.join(__dirname, '..', 'build', 'icon.png');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, png);
console.log(`Wrote ${outPath} (${png.length} bytes)`);
```

- [ ] **Step 2: Generate and validate the icon**

Run: `npm run icon && node -e "const b=require('fs').readFileSync('build/icon.png'); console.log('PNG sig ok:', b[0]===0x89 && b[1]===0x50); console.log('size:', b.readUInt32BE(16), 'x', b.readUInt32BE(20))"`
Expected: `PNG sig ok: true` and `size: 512 x 512`.

- [ ] **Step 3: Commit**

```bash
git add scripts/generate-icon.js build/icon.png
git commit -m "build: add deterministic app icon generator and icon"
```

---

### Task 5: `scripts/freeze-sidecar.sh`

**Files:**
- Create: `scripts/freeze-sidecar.sh`

- [ ] **Step 1: Create the script**

Create `scripts/freeze-sidecar.sh` (content per spec §5.2, including the Python candidate fallback):

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

- [ ] **Step 2: Make it executable and syntax-check**

Run: `chmod +x scripts/freeze-sidecar.sh && sh -n scripts/freeze-sidecar.sh && echo syntax-ok`
Expected: `syntax-ok`.

- [ ] **Step 3: Commit**

```bash
git add scripts/freeze-sidecar.sh
git commit -m "build: add PyInstaller sidecar freeze script"
```

---

### Task 6: `docs/packaging.md`

**Files:**
- Create: `docs/packaging.md`

- [ ] **Step 1: Write the build guide**

Create `docs/packaging.md`:

````markdown
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
````

- [ ] **Step 2: Commit**

```bash
git add docs/packaging.md
git commit -m "docs: add per-platform packaging guide"
```

---

### Task 7: Build validation on the dev machine (Linux)

**Files:** none (validation + fix-forward; commit any fixes)

- [ ] **Step 1: Freeze the sidecar**

Run: `pip install pyinstaller 2>&1 | tail -1; npm run freeze:sidecar`
Expected: `dist-sidecar/pdf-inspector-sidecar` exists. If pip install fails (offline/managed env), try `pip install --user pyinstaller` or `python3 -m pip install --break-system-packages pyinstaller`; if PyInstaller cannot be installed at all, STOP and report — do not fake the artifact.

- [ ] **Step 2: Smoke-test the frozen binary**

Run: `(echo ''; sleep 3) | ./dist-sidecar/pdf-inspector-sidecar & sleep 2; kill %1 2>/dev/null; echo binary-started`
Expected: process starts and stays alive awaiting stdin — no immediate exit, no Python traceback on stderr.

- [ ] **Step 3: Full test suite + build**

Run: `npx tsc -b && npx vitest run && npm run build`
Expected: no type errors, all tests pass, three bundles built.

- [ ] **Step 4: Package for Linux**

Run: `npm run dist:linux`
Expected: `release/` contains `PDF Inspector-0.1.0.AppImage` (or similar) and a `.deb`. electron-builder may download tooling on first run — allow time. If the deb target fails for missing system tools, record the error, keep AppImage, and report.

- [ ] **Step 5: Inspect the packaged resources**

Run: `ls release/linux-unpacked/resources/sidecar/ 2>/dev/null || npx electron-builder --linux dir`
Expected: `pdf-inspector-sidecar` present under `resources/sidecar/` in the unpacked layout.

- [ ] **Step 6: Commit any fixes discovered during validation**

```bash
git add -A
git commit -m "fix: packaging validation polish"
```

(Skip if nothing changed. Do NOT commit `dist-sidecar/`, `release/`, or `sidecar/build/` — they are build output; add them to `.gitignore` in this step if not already covered: `dist-sidecar/` and `sidecar/build/`.)

---

## Spec Coverage Summary

| Spec § | Requirement | Task(s) |
|--------|-------------|---------|
| §4.2 / §5.3 | `resolveSidecarCommand` pure function (packaged binary / dev python) | 1 |
| §5.4 | unit tests (packaged win/linux/mac/unknown, dev linux/win) | 1 |
| §5.3 | `start()` integration + packaged existence check + clear error | 2 |
| §5.1 | `electron-builder.yml` (targets, extraResources, NSIS/AppImage/deb/dmg) | 3 |
| §5.5 | package.json freeze/dist scripts | 3 |
| §5.6 | `build/icon.png` 512×512 | 4 |
| §5.2 | `scripts/freeze-sidecar.sh` with python candidate fallback | 5 |
| §5.7 | `docs/packaging.md` per-platform guide | 6 |
| §7 | error handling: missing binary error, freeze failure surfaces | 2, 5, 7 |
| §8 | build validation: freeze smoke test, dist:linux artifacts | 7 |


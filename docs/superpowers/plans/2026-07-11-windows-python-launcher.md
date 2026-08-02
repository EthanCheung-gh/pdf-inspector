# Windows Python Launcher Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-subagent-driven-development (recommended) or superpowers-executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Electron main process detect and spawn the correct Python command on Windows (`py -3` / `python`) while keeping `python3` on macOS/Linux.

**Architecture:** Extract platform-specific Python command resolution into a shared module (`src/shared/python-resolver.ts`) consumed by both `index.ts` (availability check) and `sidecar.ts` (subprocess spawn). On Windows, attempt `py -3` first (Python Launcher), then fall back to `python`; non-Windows uses `python3` exclusively.

**Tech Stack:** TypeScript, Node.js `child_process` (`execSync`/`spawn`), vitest, Electron.

---

## File Structure

```
src/shared/python-resolver.ts        # CREATE — platform-aware Python command resolution
src/shared/__tests__/python-resolver.test.ts  # CREATE — unit tests for resolver
vitest.config.ts                     # CREATE — vitest configuration for Node tests
src/main/index.ts                    # MODIFY — use resolver for availability check
src/main/sidecar.ts                  # MODIFY — use resolver for subprocess spawn
```

---

### Task 1: Create shared Python command resolver module

**Files:**
- Create: `src/shared/python-resolver.ts`
- Create: `src/shared/__tests__/python-resolver.test.ts`
- Create: `vitest.config.ts`

- [ ] **Step 1.1: Create `vitest.config.ts`**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
```

- [ ] **Step 1.2: Write the failing test**

```typescript
import { describe, it, expect, afterEach } from 'vitest';
import { resolvePythonCommand, getPythonCandidates } from '../python-resolver';

describe('resolvePythonCommand', () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  });

  it('returns py -3 on Windows', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    expect(resolvePythonCommand()).toEqual({ command: 'py', args: ['-3'] });
  });

  it('returns python3 on Linux', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    expect(resolvePythonCommand()).toEqual({ command: 'python3', args: [] });
  });

  it('returns python3 on macOS', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    expect(resolvePythonCommand()).toEqual({ command: 'python3', args: [] });
  });
});

describe('getPythonCandidates', () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  });

  it('returns two candidates on Windows: py -3 then python', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    expect(getPythonCandidates()).toEqual([
      { command: 'py', args: ['-3'] },
      { command: 'python', args: [] },
    ]);
  });

  it('returns single candidate python3 on non-Windows', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    expect(getPythonCandidates()).toEqual([
      { command: 'python3', args: [] },
    ]);
  });
});
```

- [ ] **Step 1.3: Run test and confirm it fails**

Run: `npx vitest run src/shared/__tests__/python-resolver.test.ts`

Expected output:

```
 FAIL  src/shared/__tests__/python-resolver.test.ts
   × resolvePythonCommand › returns py -3 on Windows
   × resolvePythonCommand › returns python3 on Linux
   × ...
```

All 5 tests fail because `../python-resolver` does not exist yet.

- [ ] **Step 1.4: Write the resolver implementation**

```typescript
/**
 * Platform-specific Python command resolution.
 *
 * On Windows the Python Launcher (`py -3`) is preferred because:
 * - python.org installs register `py` (the launcher) but NOT `python3`
 * - The launcher auto-selects the latest Python 3.x
 * - `python` may resolve to Python 2 if installed
 *
 * On macOS/Linux, `python3` is the standard name.
 */

export interface PythonCommand {
  command: string;
  args: string[];
}

/**
 * Returns the single best Python command for spawning a subprocess.
 * Called by SidecarManager.start() after Python availability is confirmed.
 */
export function resolvePythonCommand(): PythonCommand {
  if (process.platform === 'win32') {
    return { command: 'py', args: ['-3'] };
  }
  return { command: 'python3', args: [] };
}

/**
 * Returns an ordered list of Python command candidates to probe.
 * The first candidate that responds to `--version` is selected.
 * Called by checkPythonAvailable() in the main process.
 */
export function getPythonCandidates(): PythonCommand[] {
  if (process.platform === 'win32') {
    return [
      { command: 'py', args: ['-3'] },
      { command: 'python', args: [] },
    ];
  }
  return [{ command: 'python3', args: [] }];
}
```

- [ ] **Step 1.5: Run test and confirm it passes**

Run: `npx vitest run src/shared/__tests__/python-resolver.test.ts`

Expected output:

```
 PASS  src/shared/__tests__/python-resolver.test.ts
  resolvePythonCommand
    ✓ returns py -3 on Windows
    ✓ returns python3 on Linux
    ✓ returns python3 on macOS
  getPythonCandidates
    ✓ returns two candidates on Windows: py -3 then python
    ✓ returns single candidate python3 on non-Windows

Tests  5 passed (5)
```

- [ ] **Step 1.6: Commit**

```bash
git add src/shared/python-resolver.ts src/shared/__tests__/python-resolver.test.ts vitest.config.ts
git commit -m "feat: add shared Python command resolver for platform-specific detection"
```

---

### Task 2: Update Python availability check in `src/main/index.ts`

**Files:**
- Modify: `src/main/index.ts` — add import after line 5; rewrite `checkPythonAvailable()` body

- [ ] **Step 2.1: Add import and rewrite `checkPythonAvailable()`**

**Old code (the top section of the file):**

```typescript
import { app, BrowserWindow, dialog } from 'electron';
import { execSync } from 'child_process';
import * as path from 'path';
import { SidecarManager } from './sidecar';
import { registerIpcHandlers } from './ipc-handlers';

let mainWindow: BrowserWindow | null = null;
const sidecar = new SidecarManager();

function checkPythonAvailable(): boolean {
  try {
    execSync('python3 --version', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}
```

**New code:**

```typescript
import { app, BrowserWindow, dialog } from 'electron';
import { execSync } from 'child_process';
import * as path from 'path';
import { SidecarManager } from './sidecar';
import { registerIpcHandlers } from './ipc-handlers';
import { getPythonCandidates } from '../shared/python-resolver';

let mainWindow: BrowserWindow | null = null;
const sidecar = new SidecarManager();

function checkPythonAvailable(): boolean {
  for (const candidate of getPythonCandidates()) {
    try {
      const cmd = [candidate.command, ...candidate.args, '--version'].join(' ');
      execSync(cmd, { stdio: 'pipe' });
      return true;
    } catch {
      // Try next candidate
    }
  }
  return false;
}
```

- [ ] **Step 2.2: Verify TypeScript compilation for this file**

Run: `npx tsc -p tsconfig.node.json --noEmit`

Expected output: no errors (exit code 0).

- [ ] **Step 2.3: Commit**

```bash
git add src/main/index.ts
git commit -m "fix: use platform-aware Python candidates in availability check"
```

---

### Task 3: Update sidecar spawn command in `src/main/sidecar.ts`

**Files:**
- Modify: `src/main/sidecar.ts` — add import after line 1; update spawn call around line 92

- [ ] **Step 3.1: Add import**

**Old import (top of file):**

```typescript
import { spawn, ChildProcess } from 'child_process';
```

**New import (add after line 1):**

```typescript
import { spawn, ChildProcess } from 'child_process';
import { resolvePythonCommand } from '../shared/python-resolver';
```

- [ ] **Step 3.2: Update spawn call**

**Old code (the spawn call in `start()`):**

```typescript
    return new Promise((resolve, reject) => {
      const proc = spawn('python3', [scriptPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
```

**New code:**

```typescript
    return new Promise((resolve, reject) => {
      const { command, args } = resolvePythonCommand();
      const proc = spawn(command, [...args, scriptPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
```

- [ ] **Step 3.3: Verify TypeScript compilation**

Run: `npx tsc -p tsconfig.node.json --noEmit`

Expected output: no errors (exit code 0).

- [ ] **Step 3.4: Commit**

```bash
git add src/main/sidecar.ts
git commit -m "fix: use platform-aware Python command for sidecar spawn"
```

---

### Task 4: Full TypeScript build verification

- [ ] **Step 4.1: Run full build**

Run: `npm run build 2>&1`

Expected output: build completes with exit code 0. Key lines:

```
> pdf-inspector@0.1.0 build
> tsc && vite build

vite v5.x.x building for production...
✓ built in X.XXs
```

(Note: `tsc` here is the renderer tsconfig; the `tsc -p tsconfig.node.json` build already passed in earlier tasks. Both must pass.)

- [ ] **Step 4.2: Run full test suite**

Run: `npx vitest run`

Expected output:

```
 PASS  src/shared/__tests__/python-resolver.test.ts
  resolvePythonCommand
    ✓ returns py -3 on Windows
    ✓ returns python3 on Linux
    ✓ returns python3 on macOS
  getPythonCandidates
    ✓ returns two candidates on Windows: py -3 then python
    ✓ returns single candidate python3 on non-Windows

Tests  5 passed (5)
```

---

### Task 5: Final commit

- [ ] **Step 5.1: Commit any remaining uncommitted changes**

Run: `git status`

Expected: working tree clean (all changes from Tasks 1-4 already committed).

If any untracked/modified files remain, stage and commit them:

```bash
git add -A
git commit -m "chore: Windows Python launcher compatibility"
```

---

## Summary of Changes

| File | Action |
|---|---|
| `vitest.config.ts` | Create — vitest Node environment config |
| `src/shared/python-resolver.ts` | Create — `resolvePythonCommand()` + `getPythonCandidates()` |
| `src/shared/__tests__/python-resolver.test.ts` | Create — 5 unit tests for platform-specific resolution |
| `src/main/index.ts` | Modify — `checkPythonAvailable()` iterates `getPythonCandidates()` |
| `src/main/sidecar.ts` | Modify — `start()` uses `resolvePythonCommand()` for spawn |

Total tasks: 5 (with commit checkpoints), ~20 minutes execution time.

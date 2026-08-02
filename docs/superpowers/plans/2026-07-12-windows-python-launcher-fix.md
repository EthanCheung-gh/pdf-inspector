# Windows Python Launcher Detection/Spawn Consistency Fix

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-subagent-driven-development (recommended) or superpowers-executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure the Python command used for sidecar spawning (`resolvePythonCommand()`) always matches the successful candidate discovered during availability detection (`checkPythonAvailable()`), preventing `py -3` from being used when detection fell back to `python`.

**Architecture:** Add an injectable selected-command cache to `python-resolver.ts`. After detection finds a working Python candidate, `index.ts` calls `setSelectedPython()` to persist it. `resolvePythonCommand()` returns the cached command instead of unconditionally defaulting to `py -3` on Windows.

**Tech Stack:** TypeScript, vitest, Electron main process.

---

## File Structure

```
src/shared/python-resolver.ts                   # MODIFY — add selectedCommand + setter
src/shared/__tests__/python-resolver.test.ts    # MODIFY — add selection/caching tests
src/main/index.ts                               # MODIFY — call setSelectedPython on detection
```

**No new files.** ~10-minute execution.

---

### Task 1: Update `python-resolver.ts` with selected-command cache

**Files:**
- Modify: `src/shared/python-resolver.ts` — add module-level `selectedCommand` variable, a public setter, and update `resolvePythonCommand()` to prefer it

- [ ] **Step 1.1: Read the current file to confirm starting state**

Run: `cat src/shared/python-resolver.ts`

Expected: the file contains `resolvePythonCommand()` and `getPythonCandidates()` as created by the previous plan.

- [ ] **Step 1.2: Edit `python-resolver.ts` — add cache and setter**

**Current file content:**

```typescript
/**
 * Platform-specific Python command resolution.
 *
 * On Windows the Python Launcher (`py -3`) is preferred because python.org
 * installs register it but do not necessarily add `python3` to PATH. On
 * macOS/Linux, `python3` is the standard name.
 */
export interface PythonCommand {
  command: string;
  args: string[];
}

/** Returns the preferred Python command for spawning a subprocess. */
export function resolvePythonCommand(): PythonCommand {
  if (process.platform === 'win32') {
    return { command: 'py', args: ['-3'] };
  }

  return { command: 'python3', args: [] };
}

/** Returns ordered Python command candidates to probe for availability. */
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

**New file content (replace entire file):**

```typescript
/**
 * Platform-specific Python command resolution.
 *
 * On Windows the Python Launcher (`py -3`) is preferred because python.org
 * installs register it but do not necessarily add `python3` to PATH. On
 * macOS/Linux, `python3` is the standard name.
 *
 * Detection (`checkPythonAvailable` in index.ts) and spawn
 * (`resolvePythonCommand` in sidecar.ts) share a consistent command through
 * a module-level cache: once a working candidate is found, it is persisted
 * via `setSelectedPython()` so spawn uses the same command.
 */
export interface PythonCommand {
  command: string;
  args: string[];
}

/** Module-level cache: the candidate that successfully responded to --version. */
let selectedCommand: PythonCommand | null = null;

/**
 * Returns the command to use for spawning the sidecar subprocess.
 *
 * - If a successful candidate was previously cached via `setSelectedPython()`,
 *   that candidate is returned.
 * - Otherwise falls back to the platform default (py -3 on Windows, python3
 *   elsewhere).
 */
export function resolvePythonCommand(): PythonCommand {
  if (selectedCommand !== null) {
    return selectedCommand;
  }
  // Fallback default per platform
  if (process.platform === 'win32') {
    return { command: 'py', args: ['-3'] };
  }
  return { command: 'python3', args: [] };
}

/**
 * Persist a successfully-probed Python command so that subsequent calls to
 * `resolvePythonCommand()` return the same candidate.
 *
 * Call this from the detection loop after `execSync('... --version')`
 * succeeds for a given candidate.
 */
export function setSelectedPython(cmd: PythonCommand): void {
  selectedCommand = cmd;
}

/**
 * Clear the cached selection (useful for testing between runs).
 */
export function resetSelectedPython(): void {
  selectedCommand = null;
}

/** Returns ordered Python command candidates to probe for availability. */
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

- [ ] **Step 1.3: Verify TypeScript compilation**

Run: `npx tsc -p tsconfig.node.json --noEmit`

Expected output: no errors (exit code 0).

- [ ] **Step 1.4: Commit**

```bash
git add src/shared/python-resolver.ts
git commit -m "feat: add selected-command cache to Python resolver for detection/spawn consistency"
```

---

### Task 2: Update `checkPythonAvailable()` in `index.ts` to cache the selected candidate

**Files:**
- Modify: `src/main/index.ts` — add `setSelectedPython` import; call it after successful `execSync`

- [ ] **Step 2.1: Edit the import line**

**Current line (line 6):**

```typescript
import { getPythonCandidates } from '../shared/python-resolver';
```

**New line:**

```typescript
import { getPythonCandidates, setSelectedPython } from '../shared/python-resolver';
```

- [ ] **Step 2.2: Edit detection loop to cache the working candidate**

**Current `checkPythonAvailable()` (lines 11-23):**

```typescript
function checkPythonAvailable(): boolean {
  for (const candidate of getPythonCandidates()) {
    try {
      const command = [candidate.command, ...candidate.args, '--version'].join(' ');
      execSync(command, { stdio: 'pipe' });
      return true;
    } catch {
      // Try the next candidate.
    }
  }

  return false;
}
```

**New code (replace the entire function):**

```typescript
function checkPythonAvailable(): boolean {
  for (const candidate of getPythonCandidates()) {
    try {
      const command = [candidate.command, ...candidate.args, '--version'].join(' ');
      execSync(command, { stdio: 'pipe' });
      setSelectedPython(candidate);
      return true;
    } catch {
      // Try the next candidate.
    }
  }

  return false;
}
```

The single added line (`setSelectedPython(candidate)`) runs only after `execSync` succeeds, so the cached command is guaranteed to work. When `SidecarManager.start()` later calls `resolvePythonCommand()`, it returns this cached candidate instead of the unconditional `py -3` default.

- [ ] **Step 2.3: Verify TypeScript compilation**

Run: `npx tsc -p tsconfig.node.json --noEmit`

Expected output: no errors (exit code 0).

- [ ] **Step 2.4: Commit**

```bash
git add src/main/index.ts
git commit -m "fix: cache selected Python candidate on detection so spawn uses same command"
```

---

### Task 3: Update tests for selection/caching behavior

**Files:**
- Modify: `src/shared/__tests__/python-resolver.test.ts` — add tests for `setSelectedPython`, `resetSelectedPython`, and that `resolvePythonCommand()` returns the selected candidate

- [ ] **Step 3.1: Read the current test file**

Run: `cat src/shared/__tests__/python-resolver.test.ts`

Expected: the 5 tests from the previous plan.

- [ ] **Step 3.2: Edit test file — update imports and add new describe block**

**Current imports (line 1-2):**

```typescript
import { afterEach, describe, expect, it } from 'vitest';
import { getPythonCandidates, resolvePythonCommand } from '../python-resolver';
```

**New imports (replace both lines):**

```typescript
import { afterEach, describe, expect, it } from 'vitest';
import {
  getPythonCandidates,
  resetSelectedPython,
  resolvePythonCommand,
  setSelectedPython,
} from '../python-resolver';
```

- [ ] **Step 3.3: Append a new `describe('selected command cache', ...)` block at the end of the file**

Append the following after the closing `});` of the outermost `getPythonCandidates` describe block (search for `describe('getPythonCandidates'` and append after its matching `});`):

```typescript
describe('selected command cache', () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    resetSelectedPython();
  });

  it('returns platform default when no selection has been made', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    expect(resolvePythonCommand()).toEqual({ command: 'py', args: ['-3'] });
  });

  it('returns platform default on non-Windows when no selection has been made', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    expect(resolvePythonCommand()).toEqual({ command: 'python3', args: [] });
  });

  it('returns selected command after setSelectedPython', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    setSelectedPython({ command: 'python', args: [] });
    expect(resolvePythonCommand()).toEqual({ command: 'python', args: [] });
  });

  it('overrides platform default even on non-Windows', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    setSelectedPython({ command: '/usr/local/bin/python3', args: ['-E'] });
    expect(resolvePythonCommand()).toEqual({ command: '/usr/local/bin/python3', args: ['-E'] });
  });

  it('returns platform default again after resetSelectedPython', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    setSelectedPython({ command: 'python', args: [] });
    resetSelectedPython();
    expect(resolvePythonCommand()).toEqual({ command: 'py', args: ['-3'] });
  });
});
```

- [ ] **Step 3.4: Run tests and confirm all pass**

Run: `npx vitest run src/shared/__tests__/python-resolver.test.ts`

Expected output:

```
 PASS  src/shared/__tests__/python-resolver.test.ts
  resolvePythonCommand
    ✓ returns py -3 on Windows
    ✓ returns python3 on Linux
    ✓ returns python3 on macOS
  getPythonCandidates
    ✓ returns py -3 then python on Windows
    ✓ returns python3 on non-Windows
  selected command cache
    ✓ returns platform default when no selection has been made
    ✓ returns platform default on non-Windows when no selection has been made
    ✓ returns selected command after setSelectedPython
    ✓ overrides platform default even on non-Windows
    ✓ returns platform default again after resetSelectedPython

Tests  10 passed (10)
```

- [ ] **Step 3.5: Commit**

```bash
git add src/shared/__tests__/python-resolver.test.ts
git commit -m "test: add tests for Python resolver selected-command cache"
```

---

### Task 4: Full build and test verification

- [ ] **Step 4.1: Run full TypeScript compilation for both tsconfigs**

Run: `npx tsc -p tsconfig.node.json --noEmit`

Expected: no errors (exit code 0).

Run: `npx tsc --noEmit`

Expected: no errors (exit code 0).

- [ ] **Step 4.2: Run full test suite**

Run: `npx vitest run`

Expected:

```
 PASS  src/shared/__tests__/python-resolver.test.ts
  ...
Tests  10 passed (10)
```

- [ ] **Step 4.3: Run npm build**

Run: `npm run build 2>&1`

Expected output: build completes with exit code 0.

```
> pdf-inspector@0.1.0 build
> tsc && vite build

vite v5.x.x building for production...
✓ built in X.XXs
```

---

### Task 5: Final commit

- [ ] **Step 5.1: Verify clean working tree**

Run: `git status`

Expected: working tree clean (all changes from Tasks 1-4 already committed).

If any untracked/modified files remain, stage and commit them:

```bash
git add -A
git commit -m "chore: finalize Windows Python launcher detection/spawn consistency fix"
```

---

## Summary of Changes

| File | Action | Description |
|---|---|---|
| `src/shared/python-resolver.ts` | Modify | Add `selectedCommand` cache, `setSelectedPython()`, `resetSelectedPython()`, and update `resolvePythonCommand()` to return cached candidate |
| `src/main/index.ts` | Modify | Add `setSelectedPython(candidate)` after successful `execSync` in `checkPythonAvailable()` |
| `src/shared/__tests__/python-resolver.test.ts` | Modify | Add 5 tests for cache: default, set, platform override, reset |

Total tasks: 5 (with commit checkpoints), ~10 minutes execution time.

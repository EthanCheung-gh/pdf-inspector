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

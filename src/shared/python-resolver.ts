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

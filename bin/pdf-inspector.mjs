#!/usr/bin/env node
/**
 * Node wrapper around the Python `pdf-inspector` CLI.
 *
 * The wrapper intentionally contains no diff logic: it only resolves a Python
 * interpreter, spawns `sidecar/cli.py` with the forwarded arguments, and
 * forwards stdio, signals and the exit code. Resolution order:
 *
 *   1. `PDF_INSPECTOR_PYTHON` (explicit override, used as-is)
 *   2. repo `.venv/bin/python` (`.venv/Scripts/python.exe` on Windows)
 *   3. `python3` from PATH
 *
 * `pythonCandidates()`/`resolvePython()` are exported so future tests can
 * exercise the fallback logic without spawning processes.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const repoRoot = path.resolve(here, '..');
export const cliEntry = path.join(repoRoot, 'sidecar', 'cli.py');

/**
 * Ordered interpreter candidates for the current environment.
 *
 * @param {{env?: NodeJS.ProcessEnv, root?: string, platform?: NodeJS.Platform}} [options]
 * @returns {{command: string, source: string}[]}
 */
export function pythonCandidates(options = {}) {
  const {
    env = process.env,
    root = repoRoot,
    platform = process.platform,
  } = options;

  const candidates = [];
  const override = (env.PDF_INSPECTOR_PYTHON || '').trim();
  if (override) {
    candidates.push({ command: override, source: 'PDF_INSPECTOR_PYTHON' });
  }

  const venvPython =
    platform === 'win32'
      ? path.join(root, '.venv', 'Scripts', 'python.exe')
      : path.join(root, '.venv', 'bin', 'python');
  candidates.push({ command: venvPython, source: 'venv' });

  candidates.push({ command: 'python3', source: 'PATH' });
  return candidates;
}

/**
 * Pick the first usable interpreter: the env override wins unconditionally,
 * a repo virtualenv is used when it exists, otherwise `python3` from PATH.
 *
 * @param {{env?: NodeJS.ProcessEnv, root?: string, platform?: NodeJS.Platform,
 *          isFile?: (candidate: string) => boolean}} [options]
 * @returns {{command: string, source: string}}
 */
export function resolvePython(options = {}) {
  const { isFile = existsSync, ...rest } = options;
  for (const candidate of pythonCandidates(rest)) {
    if (candidate.source === 'PATH' || candidate.source === 'PDF_INSPECTOR_PYTHON') {
      return candidate;
    }
    if (isFile(candidate.command)) {
      return candidate;
    }
  }
  // `pythonCandidates` always ends with `python3`.
  return { command: 'python3', source: 'PATH' };
}

/**
 * Forwarded signals are re-raised on this process so the shell observes the
 * same termination status as the CLI would have produced.
 */
const FORWARDED_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];

function main(argv) {
  if (!existsSync(cliEntry)) {
    process.stderr.write(
      `pdf-inspector: cannot find sidecar/cli.py at ${cliEntry}\n`,
    );
    return 1;
  }

  const python = resolvePython();
  const child = spawn(python.command, [cliEntry, ...argv], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: process.env,
  });

  const handlers = new Map();
  for (const signal of FORWARDED_SIGNALS) {
    const handler = () => {
      if (!child.killed) {
        try {
          child.kill(signal);
        } catch {
          // The child may have exited between the signal and kill().
        }
      }
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }

  const cleanup = () => {
    for (const [signal, handler] of handlers) {
      process.off(signal, handler);
    }
  };

  let spawnFailed = false;
  child.on('error', (error) => {
    spawnFailed = true;
    cleanup();
    const hint =
      error && error.code === 'ENOENT'
        ? ` (set PDF_INSPECTOR_PYTHON to a Python interpreter)`
        : '';
    process.stderr.write(
      `pdf-inspector: failed to start ${python.command}: ${error.message}${hint}\n`,
    );
    process.exitCode = 127;
  });

  child.on('close', (code, signal) => {
    cleanup();
    if (spawnFailed) {
      return;
    }
    if (signal) {
      // Re-raise the signal with no listener attached: the default action
      // terminates this process with the same signal.
      try {
        process.kill(process.pid, signal);
      } catch {
        process.exitCode = 128 + (osSignalNumber(signal) || 0);
      }
      return;
    }
    process.exitCode = code === null ? 1 : code;
  });
}

function osSignalNumber(signal) {
  // Avoid importing node:os for one lookup; values are stable on POSIX.
  const numbers = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 };
  return numbers[signal];
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  main(process.argv.slice(2));
}

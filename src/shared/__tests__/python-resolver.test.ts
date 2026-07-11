import { afterEach, describe, expect, it } from 'vitest';
import { getPythonCandidates, resolvePythonCommand } from '../python-resolver';

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

  it('returns py -3 then python on Windows', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

    expect(getPythonCandidates()).toEqual([
      { command: 'py', args: ['-3'] },
      { command: 'python', args: [] },
    ]);
  });

  it('returns python3 on non-Windows', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });

    expect(getPythonCandidates()).toEqual([{ command: 'python3', args: [] }]);
  });
});

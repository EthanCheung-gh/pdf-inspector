import { afterEach, describe, expect, it } from 'vitest';
import {
  getPythonCandidates,
  resetSelectedPython,
  resolvePythonCommand,
  setSelectedPython,
} from '../python-resolver';

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

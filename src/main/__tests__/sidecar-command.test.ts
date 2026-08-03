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

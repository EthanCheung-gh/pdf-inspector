import { beforeEach, describe, expect, it, vi } from 'vitest';

const bridge = vi.hoisted(() => ({ openExternal: vi.fn() }));

// The service is the policy layer above the bridge, so the bridge is replaced
// entirely: every assertion is about what did (or did not) cross it.
vi.mock('../ipc-client', () => ({
  ipc: { openExternal: bridge.openExternal },
}));

import { UNSAFE_EXTERNAL_URL_ERROR, openExternalUrl } from '../external-link';

beforeEach(() => {
  bridge.openExternal.mockReset();
});

describe('openExternalUrl', () => {
  it('opens a safe http(s) URL through the bridge', async () => {
    bridge.openExternal.mockResolvedValue({ ok: true });

    await expect(openExternalUrl('https://example.com/report')).resolves.toEqual({ ok: true });
    expect(bridge.openExternal).toHaveBeenCalledTimes(1);
    expect(bridge.openExternal).toHaveBeenCalledWith('https://example.com/report');
  });

  it('hands the opener the trimmed URL it validated', async () => {
    bridge.openExternal.mockResolvedValue({ ok: true });

    await openExternalUrl('  http://example.com/a?b=1  ');

    expect(bridge.openExternal).toHaveBeenCalledWith('http://example.com/a?b=1');
  });

  it('refuses every unsafe target before it reaches IPC', async () => {
    for (const url of [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      'data:text/html,<b>x</b>',
      'file:///etc/passwd',
      'mailto:user@example.com',
      'ftp://example.com/file.pdf',
      '/relative/path',
      '//example.com/path',
      'http://example.com/\u0000',
      '',
      '   ',
      null,
    ]) {
      const result = await openExternalUrl(url);

      expect(result).toEqual({ ok: false, error: UNSAFE_EXTERNAL_URL_ERROR });
    }

    expect(bridge.openExternal).not.toHaveBeenCalled();
  });

  it('never opens PDF.js unsafeUrl: only the sanitized value is accepted', async () => {
    bridge.openExternal.mockResolvedValue({ ok: true });

    // A `javascript:` entry keeps its raw value for display, but activating it
    // goes through the same validator as any other link.
    const result = await openExternalUrl('javascript:alert(document.cookie)');

    expect(result.ok).toBe(false);
    expect(bridge.openExternal).not.toHaveBeenCalled();
  });

  it('reports the bridge error without throwing', async () => {
    bridge.openExternal.mockResolvedValue({ ok: false, error: 'no handler for https' });

    await expect(openExternalUrl('https://example.com')).resolves.toEqual({
      ok: false,
      error: 'no handler for https',
    });
  });

  it('falls back to a readable message when the bridge gives no reason', async () => {
    bridge.openExternal.mockResolvedValue({ ok: false });

    await expect(openExternalUrl('https://example.com')).resolves.toEqual({
      ok: false,
      error: 'Could not open the link',
    });
  });

  it('converts a rejected bridge call into a typed result', async () => {
    bridge.openExternal.mockRejectedValueOnce(new Error('IPC exploded'));
    await expect(openExternalUrl('https://example.com')).resolves.toEqual({
      ok: false,
      error: 'IPC exploded',
    });

    bridge.openExternal.mockRejectedValueOnce('raw string failure');
    await expect(openExternalUrl('https://example.com')).resolves.toEqual({
      ok: false,
      error: 'Could not open the link',
    });
  });

  it('converts a malformed bridge reply into a typed result', async () => {
    bridge.openExternal.mockResolvedValue(undefined);

    await expect(openExternalUrl('https://example.com')).resolves.toEqual({
      ok: false,
      error: 'Could not open the link',
    });
  });
});

// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcApi } from '../../renderer/types/ipc-protocol';
import { UNSAFE_EXTERNAL_URL_ERROR } from '../../shared/external-url';
import { installWebIpc, openExternalInBrowser } from '../ipc-adapter';

type BrowserWindow = { pdfInspector?: IpcApi };

const NOOPENER_FEATURES = 'noopener,noreferrer';

/** jsdom defines `window.open` as read-only, so it is replaced via `defineProperty`. */
const originalOpen = window.open;

let fetchMock: ReturnType<typeof vi.fn>;
let openMock: ReturnType<typeof vi.fn>;

function api(): IpcApi {
  const installed = (window as unknown as BrowserWindow).pdfInspector;
  if (!installed) throw new Error('window.pdfInspector was not installed');
  return installed;
}

function setWindowOpen(value: unknown): void {
  Object.defineProperty(window, 'open', { value, configurable: true, writable: true });
}

beforeEach(() => {
  delete (window as unknown as BrowserWindow).pdfInspector;
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  openMock = vi.fn(() => null);
  setWindowOpen(openMock);
  installWebIpc();
});

afterEach(() => {
  vi.restoreAllMocks();
  setWindowOpen(originalOpen);
  delete (window as unknown as BrowserWindow).pdfInspector;
});

describe('web ipc adapter openExternal', () => {
  it('opens a safe link in a new tab with noopener and noreferrer', async () => {
    await expect(api().openExternal('https://example.com/report')).resolves.toEqual({ ok: true });

    expect(openMock).toHaveBeenCalledTimes(1);
    expect(openMock).toHaveBeenCalledWith('https://example.com/report', '_blank', NOOPENER_FEATURES);
    // A link is never fetched by the app itself.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('opens exactly the trimmed URL it validated', async () => {
    await api().openExternal('   http://example.com/a?b=1   ');

    expect(openMock).toHaveBeenCalledWith('http://example.com/a?b=1', '_blank', NOOPENER_FEATURES);
  });

  it('refuses every unsafe target without opening a tab', async () => {
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
    ]) {
      await expect(api().openExternal(url)).resolves.toEqual({
        ok: false,
        error: UNSAFE_EXTERNAL_URL_ERROR,
      });
    }

    expect(openMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports a missing window.open instead of throwing', async () => {
    // Some embedded browsers expose `window` without a usable opener.
    setWindowOpen(undefined);

    await expect(api().openExternal('https://example.com')).resolves.toEqual({
      ok: false,
      error: 'Opening links is not available in this browser',
    });
  });

  it('reports a throwing window.open instead of throwing', async () => {
    openMock.mockImplementationOnce(() => {
      throw new Error('popup blocked');
    });

    await expect(api().openExternal('https://example.com')).resolves.toEqual({
      ok: false,
      error: 'popup blocked',
    });
  });
});

describe('openExternalInBrowser', () => {
  it('treats a null window handle as success', () => {
    // `window.open` returns null whenever `noopener` is requested, whether or
    // not a tab opened, so a null handle must not be reported as a failure.
    openMock.mockReturnValueOnce(null);

    expect(openExternalInBrowser('https://example.com')).toEqual({ ok: true });
    expect(openMock).toHaveBeenCalledWith('https://example.com', '_blank', NOOPENER_FEATURES);
  });
});

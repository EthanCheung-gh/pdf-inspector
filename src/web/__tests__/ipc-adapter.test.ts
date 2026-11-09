// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiffResult, IpcApi } from '../../renderer/types/ipc-protocol';
import type { PageData, PdfMetadata } from '../../renderer/types/pdf-objects';
import { buildDiffUploadRequest, buildOpenPdfRequest, installWebIpc } from '../ipc-adapter';

/** jsdom default origin; the adapter resolves document paths against it. */
const ORIGIN = window.location.origin;

type BrowserWindow = { pdfInspector?: IpcApi };

const PDF_METADATA: PdfMetadata = {
  pages: 2,
  version: '1.7',
  encrypted: false,
  page_w: 612,
  page_h: 792,
  title: 'Sample',
  author: 'Tester',
  producer: 'pdf-inspector',
  fonts: ['Helvetica'],
};

const PAGE_DATA: PageData = {
  width: 612,
  height: 792,
  chars: [],
  words: [],
  rects: [],
  lines: [],
  curves: [],
  images: [],
  tables: [],
};

const DIFF_RESULT: DiffResult = {
  schemaVersion: 1,
  tool: { name: 'pdf-inspector', version: '0.2.0' },
  options: {
    positionTolerance: 2,
    textTolerance: 'normalized',
    ignoreTypes: ['image'],
    ignoreFonts: false,
    ignoreColors: false,
    ignoreImages: false,
    ignoreRegions: [],
  },
  old: { pages: 1, sha256: 'a'.repeat(64) },
  new: { pages: 1, sha256: 'b'.repeat(64) },
  summary: {
    pagesAdded: 0,
    pagesRemoved: 0,
    pagesChanged: 1,
    pagesReordered: 0,
    objectsAdded: 0,
    objectsRemoved: 0,
    objectsMoved: 0,
    objectsModified: 1,
  },
  pages: [],
};

let fetchMock: ReturnType<typeof vi.fn>;

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function errorResponse(body: string, status = 500, statusText = 'Internal Server Error'): Response {
  return {
    ok: false,
    status,
    statusText,
    text: async () => body,
    json: async () => {
      throw new Error('not json');
    },
  } as unknown as Response;
}

function api(): IpcApi {
  const installed = (window as unknown as BrowserWindow).pdfInspector;
  if (!installed) throw new Error('window.pdfInspector was not installed');
  return installed;
}

/** Body of the Nth fetch call, parsed from the JSON request payload. */
function sentJson(callIndex = 0): unknown {
  const init = fetchMock.mock.calls[callIndex][1] as RequestInit;
  return JSON.parse(String(init.body));
}

describe('web ipc adapter', () => {
  beforeEach(() => {
    delete (window as unknown as BrowserWindow).pdfInspector;
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    installWebIpc();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete (window as unknown as BrowserWindow).pdfInspector;
  });

  it('installs the bridge once and leaves an existing bridge untouched', () => {
    const installed = api();
    expect(installWebIpc()).toBe(false);
    expect(api()).toBe(installed);

    delete (window as unknown as BrowserWindow).pdfInspector;
    expect(installWebIpc()).toBe(true);
    expect(api()).not.toBe(installed);
  });

  it('implements every IpcApi method', () => {
    expect(Object.keys(api()).sort()).toEqual(
      [
        'analyzeFonts',
        'auditDocument',
        'auditPages',
        'diffPdfs',
        'extractMetadata',
        'extractPage',
        'getImageData',
        'getSidecarStatus',
        'openExternal',
        'openPdf',
        'openPdfUrl',
        'pickDiffPdf',
        'rawDocument',
        'rawObject',
        'rawPageContent',
        'restartSidecar',
        'saveFile',
      ].sort(),
    );
  });

  it('forwards extract_page over POST /api/rpc and returns the result as-is', async () => {
    fetchMock.mockResolvedValue(jsonResponse(PAGE_DATA));

    const result = await api().extractPage(3);

    expect(result).toBe(PAGE_DATA);
    expect(fetchMock).toHaveBeenCalledWith('/api/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'extract_page', params: { page: 3 } }),
    });
  });

  it('forwards extract_metadata and get_image_data', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(PDF_METADATA));
    expect(await api().extractMetadata()).toBe(PDF_METADATA);
    expect(sentJson(0)).toEqual({ method: 'extract_metadata' });

    fetchMock.mockResolvedValueOnce(jsonResponse({ base64: 'AAAA', format: 'png' }));
    expect(await api().getImageData('stream-7')).toEqual({ base64: 'AAAA', format: 'png' });
    expect(sentJson(1)).toEqual({
      method: 'get_image_data',
      params: { stream_id: 'stream-7' },
    });
  });

  it('sends only the supplied analyze_fonts range bounds', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ fonts: [] }));

    await api().analyzeFonts(2, 5);
    expect(sentJson(0)).toEqual({
      method: 'analyze_fonts',
      params: { start_page: 2, end_page: 5 },
    });

    fetchMock.mockClear();
    await api().analyzeFonts();
    expect(sentJson(0)).toEqual({ method: 'analyze_fonts', params: {} });
  });

  it('throws the server error message on a failed RPC', async () => {
    fetchMock.mockResolvedValue(errorResponse(JSON.stringify({ error: 'Sidecar crashed' })));

    await expect(api().extractPage(1)).rejects.toThrow('Sidecar crashed');
  });

  it('falls back to the response text when the error body is not JSON', async () => {
    fetchMock.mockResolvedValue(errorResponse('<html>Bad gateway</html>', 502, 'Bad Gateway'));

    await expect(api().extractMetadata()).rejects.toThrow('<html>Bad gateway</html>');
  });

  it('opens a URL and resolves the returned document path against the origin', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        canceled: false,
        path: '/doc/abc123/remote%20file.pdf',
        metadata: PDF_METADATA,
        sourceUrl: 'https://example.com/remote%20file.pdf',
        name: 'remote file.pdf',
      }),
    );

    const result = await api().openPdfUrl('https://example.com/remote%20file.pdf');

    expect(fetchMock).toHaveBeenCalledWith('/api/open-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/remote%20file.pdf' }),
    });
    expect(result).toEqual({
      canceled: false,
      path: `${ORIGIN}/doc/abc123/remote%20file.pdf`,
      metadata: PDF_METADATA,
      sourceUrl: 'https://example.com/remote%20file.pdf',
    });
  });

  it('propagates the server error for a failed open-url', async () => {
    fetchMock.mockResolvedValue(errorResponse(JSON.stringify({ error: 'Download failed' })));

    await expect(api().openPdfUrl('https://example.com/missing.pdf')).rejects.toThrow(
      'Download failed',
    );
  });

  it('reports sidecar status and restarts the sidecar', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ running: true }));
    expect(await api().getSidecarStatus()).toEqual({ running: true });
    expect(fetchMock).toHaveBeenCalledWith('/api/status', { method: 'GET' });

    fetchMock.mockResolvedValueOnce(jsonResponse({ success: false, running: false, error: 'boom' }));
    expect(await api().restartSidecar()).toEqual({
      success: false,
      running: false,
      error: 'boom',
    });
    expect(fetchMock.mock.calls[1][0]).toBe('/api/restart');
    expect((fetchMock.mock.calls[1][1] as RequestInit).method).toBe('POST');
  });

  it('builds the raw PDF upload request with a URI-encoded file name', () => {
    const file = new File(['%PDF-1.7'], 'my report #1.pdf', { type: 'application/pdf' });
    const { url, init } = buildOpenPdfRequest(file);

    expect(url).toBe('/api/open');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(file);
    expect(init.headers).toEqual({
      'Content-Type': 'application/pdf',
      'X-Filename': encodeURIComponent('my report #1.pdf'),
    });
    expect((init.headers as Record<string, string>)['X-Filename']).not.toContain(' ');
  });

  it('builds a diff upload request that names its side', () => {
    const file = new File(['%PDF-1.7'], 'old version.pdf', { type: 'application/pdf' });
    const { url, init } = buildDiffUploadRequest(file, 'old');

    expect(url).toBe('/api/diff/file');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(file);
    expect(init.headers).toEqual({
      'Content-Type': 'application/pdf',
      'X-Filename': encodeURIComponent('old version.pdf'),
      'X-Diff-Side': 'old',
    });
  });

  it('uploads both diff sides and posts their tokens with camelCase options', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ token: 'old-token', side: 'old' }))
      .mockResolvedValueOnce(jsonResponse({ token: 'new-token', side: 'new' }))
      .mockResolvedValueOnce(jsonResponse(DIFF_RESULT));

    const oldFile = new File(['%PDF-1.7'], 'old.pdf', { type: 'application/pdf' });
    const newFile = new File(['%PDF-1.7'], 'new.pdf', { type: 'application/pdf' });

    const result = await api().diffPdfs(oldFile, newFile, {
      positionTolerance: 2,
      ignoreTypes: ['image'],
    });

    expect(result).toBe(DIFF_RESULT);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/diff/file');
    expect(fetchMock.mock.calls[1][0]).toBe('/api/diff/file');
    expect((fetchMock.mock.calls[0][1] as RequestInit).body).toBe(oldFile);
    expect((fetchMock.mock.calls[1][1] as RequestInit).body).toBe(newFile);
    expect(
      ((fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>)[
        'X-Diff-Side'
      ],
    ).toBe('old');
    expect(
      ((fetchMock.mock.calls[1][1] as RequestInit).headers as Record<string, string>)[
        'X-Diff-Side'
      ],
    ).toBe('new');

    expect(fetchMock.mock.calls[2][0]).toBe('/api/diff');
    expect(sentJson(2)).toEqual({
      oldToken: 'old-token',
      newToken: 'new-token',
      options: { positionTolerance: 2, ignoreTypes: ['image'] },
    });
  });

  it('sends empty options when the caller provides none', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ token: 'old-token' }))
      .mockResolvedValueOnce(jsonResponse({ token: 'new-token' }))
      .mockResolvedValueOnce(jsonResponse(DIFF_RESULT));

    await api().diffPdfs(
      new File(['%PDF-1.7'], 'old.pdf', { type: 'application/pdf' }),
      new File(['%PDF-1.7'], 'new.pdf', { type: 'application/pdf' }),
    );

    expect(sentJson(2)).toEqual({ oldToken: 'old-token', newToken: 'new-token', options: {} });
  });

  it('rejects file paths in the browser diff instead of posting them', async () => {    await expect(api().diffPdfs('/tmp/old.pdf', '/tmp/new.pdf')).rejects.toThrow(
      /two selected files/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('propagates a diff upload error and a missing token', async () => {
    fetchMock.mockResolvedValueOnce(errorResponse(JSON.stringify({ error: 'not a PDF' }), 400));
    await expect(
      api().diffPdfs(
        new File(['nope'], 'old.pdf', { type: 'application/pdf' }),
        new File(['%PDF-1.7'], 'new.pdf', { type: 'application/pdf' }),
      ),
    ).rejects.toThrow('not a PDF');

    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({}))
      .mockResolvedValueOnce(jsonResponse({ token: 'new-token' }))
      .mockResolvedValueOnce(jsonResponse(DIFF_RESULT));
    await expect(
      api().diffPdfs(
        new File(['%PDF-1.7'], 'old.pdf', { type: 'application/pdf' }),
        new File(['%PDF-1.7'], 'new.pdf', { type: 'application/pdf' }),
      ),
    ).rejects.toThrow('Server returned no diff upload token');
    // The old upload answered without a token, so the new side is never sent.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('picks a diff side from a hidden file input without uploading anything', async () => {
    const file = new File(['%PDF-1.7'], 'old version.pdf', { type: 'application/pdf' });

    const pending = api().pickDiffPdf('old');
    const input = document.querySelector('input[type="file"]');
    if (!(input instanceof HTMLInputElement)) throw new Error('no file input was created');
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change'));

    await expect(pending).resolves.toEqual({ canceled: false, source: file, name: 'old version.pdf' });
    // Picking is purely local: nothing reaches the backend until the user compares.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports a cancelled diff file picker', async () => {
    const pending = api().pickDiffPdf('new');
    const input = document.querySelector('input[type="file"]');
    if (!(input instanceof HTMLInputElement)) throw new Error('no file input was created');
    input.dispatchEvent(new Event('cancel'));

    await expect(pending).resolves.toEqual({ canceled: true });
    expect(document.querySelector('input[type="file"]')).toBeNull();
  });

  it('downloads the export under the basename of defaultPath', async () => {
    const objectUrlSpy = vi.fn(() => 'blob:mock-url');
    const revokeSpy = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', {
      value: objectUrlSpy,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      value: revokeSpy,
      configurable: true,
      writable: true,
    });

    const clicked: { download?: string; href?: string } = {};
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function (this: HTMLAnchorElement) {
        clicked.download = this.download;
        clicked.href = this.href;
      });

    vi.useFakeTimers();
    const result = await api().saveFile({
      defaultPath: 'C:\\Users\\tester\\Downloads\\page-2.json',
      content: '{"page":2}',
      filterName: 'JSON',
      extensions: ['json'],
    });

    expect(result).toEqual({
      canceled: false,
      filePath: 'C:\\Users\\tester\\Downloads\\page-2.json',
    });
    expect(objectUrlSpy).toHaveBeenCalledTimes(1);
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(clicked.download).toBe('page-2.json');
    expect(clicked.href).toBe('blob:mock-url');
    // The download is triggered synchronously; the URL is revoked later so the
    // browser can finish reading the blob.
    expect(revokeSpy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(revokeSpy).toHaveBeenCalledWith('blob:mock-url');
    // No fetch call: saving is a pure browser download.
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

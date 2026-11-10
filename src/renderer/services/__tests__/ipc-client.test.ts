import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ANALYZE_FONTS_RENDERER_TIMEOUT_MS,
  ANALYZE_FONTS_TIMEOUT_MS,
  EXTRACT_PAGE_RENDERER_TIMEOUT_MS,
  EXTRACT_PAGE_TIMEOUT_MS,
  OPEN_PDF_RENDERER_TIMEOUT_MS,
  OPEN_PDF_TIMEOUT_MS,
  OPEN_PDF_URL_TIMEOUT_MS,
  PDF_URL_TIMEOUT_MS,
} from '../../../shared/constants';

const mockRestartSidecar = vi.fn();
const mockExtractPage = vi.fn();
const mockAnalyzeFonts = vi.fn();
const mockOpenPdf = vi.fn();
const mockOpenPdfUrl = vi.fn();
const mockDiffPdfs = vi.fn();

globalThis.window = {
  pdfInspector: {
    restartSidecar: mockRestartSidecar,
    extractPage: mockExtractPage,
    openPdf: mockOpenPdf,
    openPdfUrl: mockOpenPdfUrl,
    extractMetadata: vi.fn(),
    analyzeFonts: mockAnalyzeFonts,
    getImageData: vi.fn(),
    getSidecarStatus: vi.fn(),
    diffPdfs: mockDiffPdfs,
  },
} as unknown as Window & typeof globalThis;

type IpcClient = typeof import('../ipc-client')['ipc'];

let ipc: IpcClient;

describe('ipc-client timeout recovery', () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    // A fresh module instance per test: the restart budget is module state and
    // must not leak between tests.
    vi.resetModules();
    ({ ipc } = await import('../ipc-client'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('extractPage resolves when the sidecar responds before the page budget', async () => {
    const pageData = { width: 612, height: 792, chars: [], words: [], rects: [], lines: [], curves: [], images: [], tables: [] };
    mockExtractPage.mockResolvedValue(pageData);

    await expect(ipc.extractPage(3)).resolves.toEqual(pageData);
    expect(mockExtractPage).toHaveBeenCalledWith(3);
    expect(mockRestartSidecar).not.toHaveBeenCalled();
  });

  it('restarts and retries once after the page extraction timeout', async () => {
    const pageData = { width: 612, height: 792, chars: [], words: [], rects: [], lines: [], curves: [], images: [], tables: [] };
    mockRestartSidecar.mockResolvedValue({ success: true, running: true });
    mockExtractPage
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValueOnce(pageData);

    const promise = ipc.extractPage(3);
    await vi.advanceTimersByTimeAsync(EXTRACT_PAGE_RENDERER_TIMEOUT_MS);
    await vi.runAllTicks();

    await expect(promise).resolves.toEqual(pageData);
    expect(mockRestartSidecar).toHaveBeenCalledTimes(1);
    expect(mockExtractPage).toHaveBeenCalledTimes(2);
  });

  it('rejects after the retry also times out', async () => {
    mockRestartSidecar.mockResolvedValue({ success: true, running: true });
    mockExtractPage.mockImplementation(() => new Promise(() => {}));

    const promise = ipc.extractPage(3);
    const rejection = expect(promise).rejects.toThrow(
      `Sidecar timeout: extractPage exceeded ${EXTRACT_PAGE_RENDERER_TIMEOUT_MS}ms`,
    );
    await vi.advanceTimersByTimeAsync(EXTRACT_PAGE_RENDERER_TIMEOUT_MS);
    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(EXTRACT_PAGE_RENDERER_TIMEOUT_MS);

    await rejection;
    expect(mockRestartSidecar).toHaveBeenCalledTimes(1);
    expect(mockExtractPage).toHaveBeenCalledTimes(2);
  });

  it('stops restarting after three timeouts inside the restart window', async () => {
    vi.setSystemTime(new Date('2100-01-01T00:00:00Z'));
    mockRestartSidecar.mockResolvedValue({ success: true, running: true });
    mockExtractPage.mockImplementation(() => new Promise(() => {}));

    for (let attempt = 0; attempt < 3; attempt += 1) {
      vi.setSystemTime(new Date('2100-01-01T00:00:00Z'));
      const promise = ipc.extractPage(3);
      const rejection = expect(promise).rejects.toThrow(
        `Sidecar timeout: extractPage exceeded ${EXTRACT_PAGE_RENDERER_TIMEOUT_MS}ms`,
      );
      await vi.advanceTimersByTimeAsync(EXTRACT_PAGE_RENDERER_TIMEOUT_MS);
      await vi.runAllTicks();
      await vi.advanceTimersByTimeAsync(EXTRACT_PAGE_RENDERER_TIMEOUT_MS);
      await rejection;
    }

    vi.setSystemTime(new Date('2100-01-01T00:00:00Z'));
    const cappedPromise = ipc.extractPage(3);
    const cappedRejection = expect(cappedPromise).rejects.toThrow(
      'Sidecar repeatedly crashes. Please restart the application.',
    );
    await vi.advanceTimersByTimeAsync(EXTRACT_PAGE_RENDERER_TIMEOUT_MS);
    await cappedRejection;

    expect(mockRestartSidecar).toHaveBeenCalledTimes(3);
  });

  it('diffPdfs has no renderer timer: a slow diff is awaited, never restarted', async () => {
    const result = { schemaVersion: 1, pages: [] };
    let resolveDiff: (value: unknown) => void = () => {};
    mockDiffPdfs.mockReturnValueOnce(new Promise((resolve) => { resolveDiff = resolve; }));

    const promise = ipc.diffPdfs('/docs/old.pdf', '/docs/new.pdf', {});
    expect(mockDiffPdfs).toHaveBeenCalledWith('/docs/old.pdf', '/docs/new.pdf', {});

    // Past the old 305s renderer cap and past every other renderer budget: the
    // progress-aware backend owns the diff timeout, so nothing restarts here.
    await vi.advanceTimersByTimeAsync(400_000);
    expect(mockRestartSidecar).not.toHaveBeenCalled();

    resolveDiff(result);
    await expect(promise).resolves.toBe(result);
    expect(mockRestartSidecar).not.toHaveBeenCalled();
    expect(mockDiffPdfs).toHaveBeenCalledTimes(1);
  });

  it('extractPage keeps waiting past the 30s default', async () => {
    // A single complex page (many tables/objects) is a legitimate slow request:
    // the generic 30s budget must not turn it into a restart.
    mockExtractPage.mockImplementation(() => new Promise(() => {}));

    let settled = false;
    const promise = ipc.extractPage(3);
    void promise.then(
      () => { settled = true; },
      () => { settled = true; },
    );

    await vi.advanceTimersByTimeAsync(30_000);
    await vi.runAllTicks();

    expect(settled).toBe(false);
    expect(mockRestartSidecar).not.toHaveBeenCalled();
  });

  it('surfaces the main-process extract_page timeout without restarting', async () => {
    // Main times out first (120s) and rejects the IPC call with its own error;
    // the renderer budget must not have fired by then.
    mockExtractPage.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          setTimeout(() => reject(new Error('Request "extract_page" timed out after 120s')), EXTRACT_PAGE_TIMEOUT_MS);
        }),
    );

    const promise = ipc.extractPage(3);
    const rejection = expect(promise).rejects.toThrow(
      'Request "extract_page" timed out after 120s',
    );

    await vi.advanceTimersByTimeAsync(30_000);
    expect(mockRestartSidecar).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(EXTRACT_PAGE_RENDERER_TIMEOUT_MS);
    await rejection;

    expect(mockRestartSidecar).not.toHaveBeenCalled();
    expect(mockExtractPage).toHaveBeenCalledTimes(1);
  });

  it('analyzeFonts resolves when the sidecar responds in time', async () => {
    const fonts = { fonts: [{ fontname: 'Helvetica', pages: [1], charCount: 9, sizeMin: 10, sizeMax: 14, colors: ['#000000'] }] };
    mockAnalyzeFonts.mockResolvedValue(fonts);

    await expect(ipc.analyzeFonts()).resolves.toEqual(fonts);
    // A no-argument call must reach the preload as "both bounds omitted", which
    // main turns into `{}` (full document).
    expect(mockAnalyzeFonts).toHaveBeenCalledWith(undefined, undefined);
    expect(mockRestartSidecar).not.toHaveBeenCalled();
  });

  it('analyzeFonts forwards a page range verbatim', async () => {
    const fonts = { fonts: [] };
    mockAnalyzeFonts.mockResolvedValue(fonts);

    await expect(ipc.analyzeFonts(1, 10)).resolves.toEqual(fonts);

    expect(mockAnalyzeFonts).toHaveBeenCalledTimes(1);
    expect(mockAnalyzeFonts).toHaveBeenCalledWith(1, 10);
    expect(mockRestartSidecar).not.toHaveBeenCalled();
  });

  it('analyzeFonts retries a ranged request with the same range', async () => {
    mockRestartSidecar.mockResolvedValue({ success: true, running: true });
    mockAnalyzeFonts
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValueOnce({ fonts: [] });

    const promise = ipc.analyzeFonts(2, 5);
    await vi.advanceTimersByTimeAsync(ANALYZE_FONTS_RENDERER_TIMEOUT_MS);
    await vi.runAllTicks();

    await expect(promise).resolves.toEqual({ fonts: [] });
    expect(mockRestartSidecar).toHaveBeenCalledTimes(1);
    // The restart must not silently widen the range back to the full document.
    expect(mockAnalyzeFonts.mock.calls).toEqual([
      [2, 5],
      [2, 5],
    ]);
  });

  it('analyzeFonts keeps waiting past the 30s default', async () => {
    mockAnalyzeFonts.mockImplementation(() => new Promise(() => {}));

    let settled = false;
    const promise = ipc.analyzeFonts();
    void promise.then(
      () => { settled = true; },
      () => { settled = true; },
    );

    await vi.advanceTimersByTimeAsync(30_000);
    await vi.runAllTicks();

    // The generic 30s budget must not apply to font analysis.
    expect(settled).toBe(false);
    expect(mockRestartSidecar).not.toHaveBeenCalled();
  });

  it('surfaces the main-process analyze_fonts timeout without restarting', async () => {
    // Main times out first (120s) and rejects the IPC call with its own error;
    // the renderer budget must not have fired by then.
    mockAnalyzeFonts.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          setTimeout(() => reject(new Error('Request "analyze_fonts" timed out after 120s')), 120_000);
        }),
    );

    const promise = ipc.analyzeFonts();
    const rejection = expect(promise).rejects.toThrow(
      'Request "analyze_fonts" timed out after 120s',
    );

    await vi.advanceTimersByTimeAsync(30_000);
    expect(mockRestartSidecar).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(90_000);
    await rejection;

    // Main's clear error reaches the caller; no restart/retry is attempted.
    expect(mockRestartSidecar).not.toHaveBeenCalled();
    expect(mockAnalyzeFonts).toHaveBeenCalledTimes(1);
  });

  it('does not restart on a main-side (non-timeout) error', async () => {
    mockAnalyzeFonts.mockRejectedValue(new Error('Request "analyze_fonts" failed: sidecar exploded'));

    await expect(ipc.analyzeFonts()).rejects.toThrow('sidecar exploded');
    expect(mockRestartSidecar).not.toHaveBeenCalled();
    expect(mockAnalyzeFonts).toHaveBeenCalledTimes(1);
  });

  it('only its own larger budget ends a request main never answers', async () => {
    mockRestartSidecar.mockResolvedValue({ success: true, running: true });
    mockAnalyzeFonts.mockImplementation(() => new Promise(() => {}));

    const promise = ipc.analyzeFonts();
    const rejection = expect(promise).rejects.toThrow(
      'Sidecar timeout: analyzeFonts exceeded 125000ms',
    );

    // Main's 120s budget has already passed: the renderer is still waiting.
    await vi.advanceTimersByTimeAsync(120_000);
    await vi.runAllTicks();
    expect(mockRestartSidecar).not.toHaveBeenCalled();

    // The renderer backstop (main wedged, no response at all) fires at 125s.
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.runAllTicks();
    expect(mockRestartSidecar).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(125_000);
    await rejection;
    expect(mockAnalyzeFonts).toHaveBeenCalledTimes(2);
  });

  it('caps analyzeFonts restarts at three within the extended window', async () => {
    vi.setSystemTime(new Date('2100-01-01T00:00:00Z'));
    mockRestartSidecar.mockResolvedValue({ success: true, running: true });
    mockAnalyzeFonts.mockImplementation(() => new Promise(() => {}));

    for (let attempt = 0; attempt < 3; attempt += 1) {
      vi.setSystemTime(new Date('2100-01-01T00:00:00Z'));
      const promise = ipc.analyzeFonts();
      const rejection = expect(promise).rejects.toThrow(
        'Sidecar timeout: analyzeFonts exceeded 125000ms',
      );
      await vi.advanceTimersByTimeAsync(125_000);
      await vi.runAllTicks();
      await vi.advanceTimersByTimeAsync(125_000);
      await rejection;
    }

    vi.setSystemTime(new Date('2100-01-01T00:00:00Z'));
    const cappedPromise = ipc.analyzeFonts();
    const cappedRejection = expect(cappedPromise).rejects.toThrow(
      'Sidecar repeatedly crashes. Please restart the application.',
    );
    await vi.advanceTimersByTimeAsync(125_000);
    await cappedRejection;

    expect(mockRestartSidecar).toHaveBeenCalledTimes(3);
  });

  it('openPdfUrl forwards the URL and resolves the result', async () => {
    const result = {
      canceled: false,
      path: '/tmp/pdf-inspector/report-1a2b3c4d.pdf',
      metadata: { pageCount: 1 },
      sourceUrl: 'https://example.com/report.pdf',
    };
    mockOpenPdfUrl.mockResolvedValue(result);

    await expect(ipc.openPdfUrl('https://example.com/report.pdf')).resolves.toEqual(result);
    expect(mockOpenPdfUrl).toHaveBeenCalledTimes(1);
    expect(mockOpenPdfUrl).toHaveBeenCalledWith('https://example.com/report.pdf');
    expect(mockRestartSidecar).not.toHaveBeenCalled();
  });

  it('openPdf keeps waiting past the 30s default', async () => {
    // Opening a large/corrupt PDF is legitimately slow: the generic budget must
    // not turn it into a "Sidecar timeout" and a restart.
    mockOpenPdf.mockImplementation(() => new Promise(() => {}));

    let settled = false;
    const promise = ipc.openPdf();
    void promise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await vi.advanceTimersByTimeAsync(30_000);
    await vi.runAllTicks();

    expect(settled).toBe(false);
    expect(mockRestartSidecar).not.toHaveBeenCalled();
  });

  it('surfaces main\u2019s open timeout instead of restarting the sidecar', async () => {
    // Main times out first (120s) and rejects the IPC call with its own error;
    // the renderer's 125s backstop must not have fired yet.
    mockOpenPdf.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          setTimeout(() => reject(new Error('Request "open" timed out after 120s')), 120_000);
        }),
    );

    const promise = ipc.openPdf();
    const rejection = expect(promise).rejects.toThrow('Request "open" timed out after 120s');

    await vi.advanceTimersByTimeAsync(OPEN_PDF_TIMEOUT_MS);
    await rejection;

    expect(mockRestartSidecar).not.toHaveBeenCalled();
    expect(mockOpenPdf).toHaveBeenCalledTimes(1);
  });

  it('restarts and retries openPdf once after its own renderer backstop', async () => {
    mockRestartSidecar.mockResolvedValue({ success: true, running: true });
    mockOpenPdf
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValueOnce({ canceled: false, path: '/tmp/large.pdf' });

    const promise = ipc.openPdf();
    await vi.advanceTimersByTimeAsync(OPEN_PDF_RENDERER_TIMEOUT_MS);
    await vi.runAllTicks();

    await expect(promise).resolves.toEqual({ canceled: false, path: '/tmp/large.pdf' });
    expect(mockRestartSidecar).toHaveBeenCalledTimes(1);
    expect(mockOpenPdf).toHaveBeenCalledTimes(2);
  });
});

describe('ipc-client openPdfPath', () => {
  // The shared fake bridge; the desktop-only method is added/removed per test.
  const bridge = globalThis.window.pdfInspector as unknown as Record<string, unknown>;

  beforeEach(async () => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.resetModules();
    delete bridge.openPdfPath;
    ({ ipc } = await import('../ipc-client'));
  });

  afterEach(() => {
    vi.useRealTimers();
    delete bridge.openPdfPath;
  });

  it('rejects clearly when the bridge cannot open a known path (web build)', async () => {
    // The browser adapter omits the method, so the tab bar stays hidden; a
    // caller that tries anyway must not fail with "undefined is not a function".
    await expect(ipc.openPdfPath('/docs/a.pdf')).rejects.toThrow(
      'Opening a local path is not available in this build',
    );
  });

  it('forwards the known path and resolves the open result', async () => {
    const opened = { canceled: false, path: '/docs/a.pdf', metadata: { pages: 3 } };
    const openPdfPath = vi.fn().mockResolvedValue(opened);
    bridge.openPdfPath = openPdfPath;

    await expect(ipc.openPdfPath('/docs/a.pdf')).resolves.toEqual(opened);

    expect(openPdfPath).toHaveBeenCalledTimes(1);
    expect(openPdfPath).toHaveBeenCalledWith('/docs/a.pdf');
    expect(mockRestartSidecar).not.toHaveBeenCalled();
  });

  it('keeps waiting past the 30s default for a large document', async () => {
    bridge.openPdfPath = vi.fn(() => new Promise(() => {}));

    let settled = false;
    const promise = ipc.openPdfPath('/docs/large.pdf');
    void promise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    // A tab switch re-opens a whole document: the generic 30s budget would turn
    // a legitimately slow open into a "Sidecar timeout" and a restart.
    await vi.advanceTimersByTimeAsync(OPEN_PDF_TIMEOUT_MS);
    await vi.runAllTicks();

    expect(settled).toBe(false);
    expect(mockRestartSidecar).not.toHaveBeenCalled();
  });
});

describe('IPC timeout budgets', () => {
  it('gives page extraction 120s and lets main lose the race, never the renderer', () => {
    expect(EXTRACT_PAGE_TIMEOUT_MS).toBe(120_000);
    expect(EXTRACT_PAGE_RENDERER_TIMEOUT_MS).toBe(125_000);
    expect(EXTRACT_PAGE_RENDERER_TIMEOUT_MS).toBeGreaterThan(EXTRACT_PAGE_TIMEOUT_MS);
  });

  it('lets the main process lose the analyzeFonts race, never the renderer', () => {
    // The renderer timer starts one IPC hop earlier, so it needs headroom.
    expect(ANALYZE_FONTS_RENDERER_TIMEOUT_MS).toBeGreaterThan(ANALYZE_FONTS_TIMEOUT_MS);
  });

  it('lets the main process lose the openPdf race, never the renderer', () => {
    expect(OPEN_PDF_TIMEOUT_MS).toBe(120_000);
    expect(OPEN_PDF_RENDERER_TIMEOUT_MS).toBeGreaterThan(OPEN_PDF_TIMEOUT_MS);
  });

  it('covers the whole main-process openPdfUrl path', () => {
    // Worst case in main: the download budget plus a full open budget (a large
    // PDF may use all of OPEN_PDF_TIMEOUT_MS). The renderer must outlast both.
    expect(OPEN_PDF_URL_TIMEOUT_MS).toBeGreaterThan(
      PDF_URL_TIMEOUT_MS + OPEN_PDF_TIMEOUT_MS,
    );
  });
});

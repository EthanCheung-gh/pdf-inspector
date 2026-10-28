import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ANALYZE_FONTS_RENDERER_TIMEOUT_MS,
  ANALYZE_FONTS_TIMEOUT_MS,
  OPEN_PDF_URL_TIMEOUT_MS,
  PDF_URL_TIMEOUT_MS,
} from '../../../shared/constants';

const mockRestartSidecar = vi.fn();
const mockExtractPage = vi.fn();
const mockAnalyzeFonts = vi.fn();
const mockOpenPdfUrl = vi.fn();

globalThis.window = {
  pdfInspector: {
    restartSidecar: mockRestartSidecar,
    extractPage: mockExtractPage,
    openPdf: vi.fn(),
    openPdfUrl: mockOpenPdfUrl,
    extractMetadata: vi.fn(),
    analyzeFonts: mockAnalyzeFonts,
    getImageData: vi.fn(),
    getSidecarStatus: vi.fn(),
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

  it('extractPage resolves when the sidecar responds before 30 seconds', async () => {
    const pageData = { width: 612, height: 792, chars: [], words: [], rects: [], lines: [], curves: [], images: [], tables: [] };
    mockExtractPage.mockResolvedValue(pageData);

    await expect(ipc.extractPage(3)).resolves.toEqual(pageData);
    expect(mockExtractPage).toHaveBeenCalledWith(3);
    expect(mockRestartSidecar).not.toHaveBeenCalled();
  });

  it('restarts and retries once after a 30 second extraction timeout', async () => {
    const pageData = { width: 612, height: 792, chars: [], words: [], rects: [], lines: [], curves: [], images: [], tables: [] };
    mockRestartSidecar.mockResolvedValue({ success: true, running: true });
    mockExtractPage
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValueOnce(pageData);

    const promise = ipc.extractPage(3);
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.runAllTicks();

    await expect(promise).resolves.toEqual(pageData);
    expect(mockRestartSidecar).toHaveBeenCalledTimes(1);
    expect(mockExtractPage).toHaveBeenCalledTimes(2);
  });

  it('rejects after the retry also times out', async () => {
    mockRestartSidecar.mockResolvedValue({ success: true, running: true });
    mockExtractPage.mockImplementation(() => new Promise(() => {}));

    const promise = ipc.extractPage(3);
    const rejection = expect(promise).rejects.toThrow('Sidecar timeout: extractPage exceeded 30000ms');
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(30_000);

    await rejection;
    expect(mockRestartSidecar).toHaveBeenCalledTimes(1);
    expect(mockExtractPage).toHaveBeenCalledTimes(2);
  });

  it('stops restarting after three timeouts within a minute', async () => {
    vi.setSystemTime(new Date('2100-01-01T00:00:00Z'));
    mockRestartSidecar.mockResolvedValue({ success: true, running: true });
    mockExtractPage.mockImplementation(() => new Promise(() => {}));

    for (let attempt = 0; attempt < 3; attempt += 1) {
      vi.setSystemTime(new Date('2100-01-01T00:00:00Z'));
      const promise = ipc.extractPage(3);
      const rejection = expect(promise).rejects.toThrow('Sidecar timeout: extractPage exceeded 30000ms');
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.runAllTicks();
      await vi.advanceTimersByTimeAsync(30_000);
      await rejection;
    }

    vi.setSystemTime(new Date('2100-01-01T00:00:00Z'));
    const cappedPromise = ipc.extractPage(3);
    const cappedRejection = expect(cappedPromise).rejects.toThrow(
      'Sidecar repeatedly crashes. Please restart the application.',
    );
    await vi.advanceTimersByTimeAsync(30_000);
    await cappedRejection;

    expect(mockRestartSidecar).toHaveBeenCalledTimes(3);
  });

  it('analyzeFonts resolves when the sidecar responds in time', async () => {
    const fonts = { fonts: [{ fontname: 'Helvetica', pages: [1], charCount: 9, sizeMin: 10, sizeMax: 14, colors: ['#000000'] }] };
    mockAnalyzeFonts.mockResolvedValue(fonts);

    await expect(ipc.analyzeFonts()).resolves.toEqual(fonts);
    expect(mockAnalyzeFonts).toHaveBeenCalledWith();
    expect(mockRestartSidecar).not.toHaveBeenCalled();
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
});

describe('IPC timeout budgets', () => {
  it('lets the main process lose the analyzeFonts race, never the renderer', () => {
    // The renderer timer starts one IPC hop earlier, so it needs headroom.
    expect(ANALYZE_FONTS_RENDERER_TIMEOUT_MS).toBeGreaterThan(ANALYZE_FONTS_TIMEOUT_MS);
  });

  it('covers the whole main-process openPdfUrl path', () => {
    // Worst case in main: the download budget plus a default-budget sidecar
    // open. The renderer must outlast both.
    expect(OPEN_PDF_URL_TIMEOUT_MS).toBeGreaterThan(PDF_URL_TIMEOUT_MS + 30_000);
  });
});

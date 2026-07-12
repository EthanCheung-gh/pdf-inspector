import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockRestartSidecar = vi.fn();
const mockExtractPage = vi.fn();

globalThis.window = {
  pdfInspector: {
    restartSidecar: mockRestartSidecar,
    extractPage: mockExtractPage,
    openPdf: vi.fn(),
    extractMetadata: vi.fn(),
    getImageData: vi.fn(),
    getSidecarStatus: vi.fn(),
  },
} as unknown as Window & typeof globalThis;

import { ipc } from '../ipc-client';

describe('ipc-client timeout recovery', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
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
});

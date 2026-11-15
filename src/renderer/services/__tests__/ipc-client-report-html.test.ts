import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REPORT_RENDER_TIMEOUT_MS } from '../../../shared/constants';
import type { AuditBaselineComparison, AuditReport } from '../../../shared/audit-types';
import type { DiffResult } from '../../../shared/diff-types';

const mockRestartSidecar = vi.fn();
const mockRenderAuditReportHtml = vi.fn();
const mockRenderDiffReportHtml = vi.fn();

// `ipc-client` reads the preload bridge lazily, so only the methods a test calls
// need to exist on the global window.
globalThis.window = {
  pdfInspector: {
    restartSidecar: mockRestartSidecar,
    renderAuditReportHtml: mockRenderAuditReportHtml,
    renderDiffReportHtml: mockRenderDiffReportHtml,
  },
} as unknown as Window & typeof globalThis;

const HTML_RESULT = { html: '<!doctype html><html></html>' };

const REPORT: AuditReport = {
  schemaVersion: 1,
  tool: { name: 'pdf-inspector', version: '0.2.0' },
  document: {
    pages: 1,
    version: '1.7',
    encrypted: false,
    title: null,
    author: null,
    producer: null,
    language: 'en',
    tagged: true,
  },
  summary: { total: 0, errors: 0, warnings: 0, info: 0 },
  findings: [],
};

const BASELINE: AuditBaselineComparison = {
  schemaVersion: 1,
  tool: { name: 'pdf-inspector', version: '0.2.0' },
  current: { pages: 1, findings: 0 },
  baseline: { pages: 1, findings: 0 },
  summary: { new: 0, existing: 0, moved: 0, escalated: 0, fixed: 0, waived: 0 },
  findings: [],
};

const RESULT = { schemaVersion: 1, pages: [] } as unknown as DiffResult;

type IpcClient = typeof import('../ipc-client')['ipc'];

let ipc: IpcClient;

describe('ipc-client report rendering wrappers', () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    // A fresh module instance per test: the restart budget is module state.
    vi.resetModules();
    ({ ipc } = await import('../ipc-client'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('forwards the audit report and its optional baseline verbatim', async () => {
    mockRenderAuditReportHtml.mockResolvedValue(HTML_RESULT);

    await expect(ipc.renderAuditReportHtml(REPORT, BASELINE)).resolves.toBe(HTML_RESULT);
    expect(mockRenderAuditReportHtml).toHaveBeenCalledWith(REPORT, BASELINE);

    await ipc.renderAuditReportHtml(REPORT);
    // `undefined` keeps meaning "no baseline was loaded".
    expect(mockRenderAuditReportHtml.mock.calls[1]).toEqual([REPORT, undefined]);
    expect(mockRestartSidecar).not.toHaveBeenCalled();
  });

  it('forwards the diff result verbatim', async () => {
    mockRenderDiffReportHtml.mockResolvedValue(HTML_RESULT);

    await expect(ipc.renderDiffReportHtml(RESULT)).resolves.toBe(HTML_RESULT);
    expect(mockRenderDiffReportHtml).toHaveBeenCalledWith(RESULT);
    expect(mockRestartSidecar).not.toHaveBeenCalled();
  });

  it('restarts and retries a wedged render after its own budget', async () => {
    mockRestartSidecar.mockResolvedValue({ success: true, running: true });
    mockRenderAuditReportHtml
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValueOnce(HTML_RESULT);

    const promise = ipc.renderAuditReportHtml(REPORT, null);
    await vi.advanceTimersByTimeAsync(REPORT_RENDER_TIMEOUT_MS + 5_000);
    await vi.runAllTicks();

    await expect(promise).resolves.toBe(HTML_RESULT);
    expect(mockRestartSidecar).toHaveBeenCalledTimes(1);
  });

  it('keeps waiting past main’s own render budget', async () => {
    mockRenderDiffReportHtml.mockImplementation(() => new Promise(() => {}));

    let settled = false;
    const promise = ipc.renderDiffReportHtml(RESULT);
    void promise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    // Main must be the side that reports a slow render: the renderer backstop
    // sits above it, so no restart is attempted at main's deadline.
    await vi.advanceTimersByTimeAsync(REPORT_RENDER_TIMEOUT_MS);

    expect(settled).toBe(false);
    expect(mockRestartSidecar).not.toHaveBeenCalled();
  });
});

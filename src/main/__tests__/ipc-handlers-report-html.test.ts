import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));

// The Electron binary download is optional in this environment, so the module
// is replaced by an IPC registry we can invoke directly.
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      harness.handlers.set(channel, handler);
    },
  },
  dialog: {
    showOpenDialog: vi.fn(),
    showSaveDialog: vi.fn(),
  },
  BrowserWindow: {
    getFocusedWindow: () => ({ id: 1 }),
    fromWebContents: () => ({ id: 1 }),
  },
  app: {
    getPath: (name: string) => `/tmp/${name}`,
  },
}));

vi.mock('node:fs/promises', () => ({ writeFile: vi.fn() }));

import {
  AUDIT_TIMEOUT_MS,
  IPC_CHANNELS,
  REPORT_RENDER_TIMEOUT_MS,
} from '../../shared/constants';
import type {
  AuditBaselineComparison,
  AuditFinding,
  AuditReport,
} from '../../shared/audit-types';
import type { DiffResult } from '../../shared/diff-types';
import type { SidecarTransport } from '../sidecar-pool';

interface SidecarStub {
  send: ReturnType<typeof vi.fn>;
  restart: ReturnType<typeof vi.fn>;
  isRunning: ReturnType<typeof vi.fn>;
  setDocumentRestorer: ReturnType<typeof vi.fn>;
}

const TOOL = { name: 'pdf-inspector', version: '0.2.0' } as const;

const FINDING: AuditFinding = {
  category: 'metadata',
  severity: 'info',
  page: null,
  title: 'Missing language',
  detail: 'The catalog has no /Lang entry.',
  evidence: null,
  recommendation: 'Set the document language.',
  fingerprint: 'a'.repeat(32),
};

const REPORT: AuditReport = {
  schemaVersion: 1,
  tool: TOOL,
  document: {
    pages: 2,
    version: '1.7',
    encrypted: false,
    title: 'Report',
    author: null,
    producer: null,
    language: 'en-US',
    tagged: true,
  },
  summary: { total: 1, errors: 0, warnings: 0, info: 1 },
  findings: [FINDING],
};

const BASELINE: AuditBaselineComparison = {
  schemaVersion: 1,
  tool: TOOL,
  current: { pages: 2, findings: 1 },
  baseline: { pages: 2, findings: 1 },
  summary: { new: 0, existing: 1, moved: 0, escalated: 0, fixed: 0, waived: 0 },
  findings: [
    {
      status: 'existing',
      fingerprint: FINDING.fingerprint as string,
      current: FINDING,
      baseline: FINDING,
    },
  ],
};

const DIFF_RESULT = {
  schemaVersion: 1,
  tool: TOOL,
  options: {
    positionTolerance: 1,
    textTolerance: 'normalized',
    ignoreTypes: [],
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
    pagesChanged: 0,
    pagesReordered: 0,
    objectsAdded: 0,
    objectsRemoved: 0,
    objectsMoved: 0,
    objectsModified: 0,
    changesTruncated: false,
  },
  truncated: false,
  pages: [],
} satisfies DiffResult;

/** Rendered reply, mirroring the renderer's `RenderReportHtmlResult`. */
const HTML_RESULT = { html: '<!doctype html><html></html>' };

let sidecar: SidecarStub;

async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = harness.handlers.get(channel);
  if (!handler) throw new Error(`No handler registered for ${channel}`);
  return handler(...args);
}

async function registerFresh(): Promise<void> {
  vi.resetModules();
  harness.handlers.clear();

  sidecar = {
    send: vi.fn(async () => HTML_RESULT),
    restart: vi.fn(async () => undefined),
    isRunning: vi.fn(() => true),
    setDocumentRestorer: vi.fn(),
  };

  const { registerIpcHandlers } = await import('../ipc-handlers');
  registerIpcHandlers(sidecar as unknown as SidecarTransport);
}

beforeEach(async () => {
  await registerFresh();
});

describe('RENDER_AUDIT_REPORT_HTML handler', () => {
  it('posts render_audit_report_html with the report and the render budget', async () => {
    const result = await invoke(IPC_CHANNELS.RENDER_AUDIT_REPORT_HTML, {}, REPORT);

    expect(result).toBe(HTML_RESULT);
    expect(sidecar.send).toHaveBeenCalledTimes(1);
    // Without a baseline the key is omitted entirely: the sidecar must see "no
    // comparison requested", not an explicit undefined it has to interpret.
    expect(sidecar.send).toHaveBeenCalledWith(
      'render_audit_report_html',
      { report: REPORT },
      REPORT_RENDER_TIMEOUT_MS,
    );
    expect(
      Object.hasOwn(sidecar.send.mock.calls[0][1] as Record<string, unknown>, 'baseline'),
    ).toBe(false);
  });

  it('forwards an explicit baseline unchanged', async () => {
    await invoke(IPC_CHANNELS.RENDER_AUDIT_REPORT_HTML, {}, REPORT, BASELINE);

    expect(sidecar.send).toHaveBeenCalledWith(
      'render_audit_report_html',
      { report: REPORT, baseline: BASELINE },
      REPORT_RENDER_TIMEOUT_MS,
    );
  });

  it('forwards an explicit null baseline so "no comparison" is unambiguous', async () => {
    await invoke(IPC_CHANNELS.RENDER_AUDIT_REPORT_HTML, {}, REPORT, null);

    expect(sidecar.send).toHaveBeenCalledWith(
      'render_audit_report_html',
      { report: REPORT, baseline: null },
      REPORT_RENDER_TIMEOUT_MS,
    );
  });

  it('rejects a missing report instead of sending an empty payload', async () => {
    await expect(invoke(IPC_CHANNELS.RENDER_AUDIT_REPORT_HTML, {})).rejects.toThrow(
      'renderAuditReportHtml requires the AuditReport to render',
    );

    expect(sidecar.send).not.toHaveBeenCalled();
  });

  it('propagates sidecar errors unchanged', async () => {
    sidecar.send.mockRejectedValueOnce(new Error('render failed'));

    await expect(
      invoke(IPC_CHANNELS.RENDER_AUDIT_REPORT_HTML, {}, REPORT),
    ).rejects.toThrow('render failed');
  });
});

describe('RENDER_DIFF_REPORT_HTML handler', () => {
  it('posts render_diff_report_html with the result and the render budget', async () => {
    const result = await invoke(IPC_CHANNELS.RENDER_DIFF_REPORT_HTML, {}, DIFF_RESULT);

    expect(result).toBe(HTML_RESULT);
    expect(sidecar.send).toHaveBeenCalledTimes(1);
    expect(sidecar.send).toHaveBeenCalledWith(
      'render_diff_report_html',
      { result: DIFF_RESULT },
      REPORT_RENDER_TIMEOUT_MS,
    );
  });

  it('rejects a missing diff result instead of sending an empty payload', async () => {
    await expect(invoke(IPC_CHANNELS.RENDER_DIFF_REPORT_HTML, {}, 'oops')).rejects.toThrow(
      'renderDiffReportHtml requires the DiffResult to render',
    );

    expect(sidecar.send).not.toHaveBeenCalled();
  });

  it('propagates sidecar errors unchanged', async () => {
    sidecar.send.mockRejectedValueOnce(new Error('no result to render'));

    await expect(
      invoke(IPC_CHANNELS.RENDER_DIFF_REPORT_HTML, {}, DIFF_RESULT),
    ).rejects.toThrow('no result to render');
  });
});

describe('report render handlers and the Inspect session', () => {
  it('never opens a document and never restarts the sidecar', async () => {
    await invoke(IPC_CHANNELS.RENDER_AUDIT_REPORT_HTML, {}, REPORT, BASELINE);
    await invoke(IPC_CHANNELS.RENDER_DIFF_REPORT_HTML, {}, DIFF_RESULT);

    expect(sidecar.send.mock.calls).toEqual([
      ['render_audit_report_html', { report: REPORT, baseline: BASELINE }, REPORT_RENDER_TIMEOUT_MS],
      ['render_diff_report_html', { result: DIFF_RESULT }, REPORT_RENDER_TIMEOUT_MS],
    ]);
    expect(sidecar.send).not.toHaveBeenCalledWith('open', expect.anything());
    expect(sidecar.restart).not.toHaveBeenCalled();
  });

  it('gives rendering its own budget instead of the default or the audit one', async () => {
    // Rendering formats a payload main already holds: no PDF is opened or
    // parsed, so it must not borrow the audit budget, but a whole report can
    // still exceed the generic 30s request budget.
    expect(REPORT_RENDER_TIMEOUT_MS).toBeGreaterThan(30_000);
    expect(REPORT_RENDER_TIMEOUT_MS).toBeLessThan(AUDIT_TIMEOUT_MS);
  });
});

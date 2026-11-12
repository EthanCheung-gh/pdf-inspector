// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcApi } from '../../renderer/types/ipc-protocol';
import type { AccessibilityReport } from '../../shared/accessibility-types';
import { installWebIpc } from '../ipc-adapter';

type BrowserWindow = { pdfInspector?: IpcApi };

const ACCESSIBILITY_REPORT: AccessibilityReport = {
  schemaVersion: 1,
  tool: { name: 'pdf-inspector', version: '0.2.0' },
  document: {
    pages: 1,
    version: '1.7',
    encrypted: false,
    tagged: true,
    hasStructTreeRoot: true,
    hasParentTree: false,
    language: null,
    title: null,
    roleMap: {},
    truncated: false,
    skipped: 0,
  },
  structure: [
    {
      id: '0',
      kind: 'element',
      role: 'Figure',
      rawRole: 'Figure',
      title: null,
      alt: null,
      actualText: null,
      lang: null,
      page: 1,
      mcid: null,
      objectNumber: null,
      attributes: {},
      truncated: false,
      children: [],
    },
  ],
  findings: [
    {
      category: 'structure',
      severity: 'warning',
      page: 1,
      title: 'Figure has no alternative text',
      detail: 'A Figure structure element has no /Alt.',
      evidence: 'role=Figure',
      recommendation: 'Add alternative text to the figure.',
    },
  ],
  summary: { total: 1, errors: 0, warnings: 1, info: 0 },
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

function errorResponse(body: string, status = 500): Response {
  return {
    ok: false,
    status,
    statusText: 'Internal Server Error',
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

/** Request body of the Nth fetch call, parsed from its JSON payload. */
function sentJson(callIndex = 0): unknown {
  const init = fetchMock.mock.calls[callIndex][1] as RequestInit;
  return JSON.parse(String(init.body));
}

beforeEach(() => {
  delete (window as unknown as BrowserWindow).pdfInspector;
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  installWebIpc();
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as unknown as BrowserWindow).pdfInspector;
});

describe('web ipc adapter accessibility', () => {
  it('forwards accessibility_document over POST /api/rpc without params', async () => {
    fetchMock.mockResolvedValue(jsonResponse(ACCESSIBILITY_REPORT));

    await expect(api().accessibilityDocument()).resolves.toBe(ACCESSIBILITY_REPORT);

    expect(fetchMock).toHaveBeenCalledWith('/api/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'accessibility_document' }),
    });
    expect(sentJson()).toEqual({ method: 'accessibility_document' });
  });

  it('never uploads a document: the parse is a plain RPC', async () => {
    fetchMock.mockResolvedValue(jsonResponse(ACCESSIBILITY_REPORT));

    await api().accessibilityDocument();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/rpc');
  });

  it('propagates a server accessibility error', async () => {
    fetchMock.mockResolvedValue(
      errorResponse(JSON.stringify({ error: 'No active document' }), 409),
    );

    await expect(api().accessibilityDocument()).rejects.toThrow('No active document');
  });
});

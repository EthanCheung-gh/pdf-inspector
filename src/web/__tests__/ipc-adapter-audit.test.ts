// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcApi } from '../../renderer/types/ipc-protocol';
import type {
  AuditDocumentResult,
  AuditPagesResult,
} from '../../shared/audit-types';
import { installWebIpc } from '../ipc-adapter';

type BrowserWindow = { pdfInspector?: IpcApi };

const DOCUMENT_RESULT: AuditDocumentResult = {
  tool: { name: 'pdf-inspector', version: '0.2.0' },
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
  findings: [],
};

const PAGES_RESULT: AuditPagesResult = {
  tool: { name: 'pdf-inspector', version: '0.2.0' },
  findings: [
    {
      category: 'images',
      severity: 'warning',
      page: 1,
      title: 'Low DPI image',
      detail: 'The image resolves to 72 DPI.',
      evidence: '96x96 px at 96x96 pt',
      recommendation: 'Export the image at 150 DPI or higher.',
    },
  ],
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

describe('web ipc adapter audit', () => {
  it('forwards audit_document over POST /api/rpc without params', async () => {
    fetchMock.mockResolvedValue(jsonResponse(DOCUMENT_RESULT));

    await expect(api().auditDocument()).resolves.toBe(DOCUMENT_RESULT);

    expect(fetchMock).toHaveBeenCalledWith('/api/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'audit_document' }),
    });
  });

  it('sends the page range for audit_pages with snake_case keys', async () => {
    fetchMock.mockResolvedValue(jsonResponse(PAGES_RESULT));

    await expect(api().auditPages(11, 20)).resolves.toBe(PAGES_RESULT);

    expect(sentJson()).toEqual({
      method: 'audit_pages',
      params: { start_page: 11, end_page: 20 },
    });
  });

  it('never uploads a document: both audit calls are plain RPCs', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(DOCUMENT_RESULT))
      .mockResolvedValueOnce(jsonResponse(PAGES_RESULT));

    await api().auditDocument();
    await api().auditPages(1, 10);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual(['/api/rpc', '/api/rpc']);
  });

  it('propagates a server audit error', async () => {
    fetchMock.mockResolvedValue(
      errorResponse(JSON.stringify({ error: 'No document open' }), 400),
    );

    await expect(api().auditDocument()).rejects.toThrow('No document open');
  });
});

// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcApi } from '../../renderer/types/ipc-protocol';
import type { RawDocument, RawObject, RawPageContent } from '../../renderer/types/raw-pdf';
import { installWebIpc } from '../ipc-adapter';

type BrowserWindow = { pdfInspector?: IpcApi };

const CATALOG_REF = { objectNumber: 1, generation: 0 };

const DOCUMENT: RawDocument = {
  pages: 2,
  version: '1.7',
  encrypted: false,
  roots: [
    { label: 'Root', ref: CATALOG_REF, value: null },
    { label: 'Info', ref: null, value: { kind: 'null' } },
  ],
};

const OBJECT: RawObject = {
  ref: { objectNumber: 15, generation: 2 },
  value: { kind: 'array', items: [{ kind: 'ref', ref: CATALOG_REF }], truncated: false },
  summary: 'array (1 item)',
};

const CONTENT: RawPageContent = { page: 3, streams: [], truncated: false };

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

describe('web ipc adapter raw', () => {
  it('forwards raw_document over POST /api/rpc without params', async () => {
    fetchMock.mockResolvedValue(jsonResponse(DOCUMENT));

    await expect(api().rawDocument()).resolves.toBe(DOCUMENT);

    expect(fetchMock).toHaveBeenCalledWith('/api/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'raw_document' }),
    });
  });

  it('maps the raw object ref to snake_case params', async () => {
    fetchMock.mockResolvedValue(jsonResponse(OBJECT));

    await expect(api().rawObject({ objectNumber: 15, generation: 2 })).resolves.toBe(OBJECT);

    expect(sentJson()).toEqual({
      method: 'raw_object',
      params: { object_number: 15, generation: 2 },
    });
  });

  it('sends generation 0 instead of dropping it', async () => {
    fetchMock.mockResolvedValue(jsonResponse(OBJECT));

    await api().rawObject({ objectNumber: 15, generation: 0 });

    expect(sentJson()).toEqual({
      method: 'raw_object',
      params: { object_number: 15, generation: 0 },
    });
  });

  it('forwards the content page', async () => {
    fetchMock.mockResolvedValue(jsonResponse(CONTENT));

    await expect(api().rawPageContent(3)).resolves.toBe(CONTENT);

    expect(sentJson()).toEqual({ method: 'raw_page_content', params: { page: 3 } });
  });

  it('never uploads a document: all three raw calls are plain RPCs', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(DOCUMENT))
      .mockResolvedValueOnce(jsonResponse(OBJECT))
      .mockResolvedValueOnce(jsonResponse(CONTENT));

    await api().rawDocument();
    await api().rawObject({ objectNumber: 15, generation: 2 });
    await api().rawPageContent(1);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      '/api/rpc',
      '/api/rpc',
      '/api/rpc',
    ]);
  });

  it('propagates a server raw error', async () => {
    fetchMock.mockResolvedValue(
      errorResponse(JSON.stringify({ error: 'Invalid object number: 9999' }), 500),
    );

    await expect(api().rawObject({ objectNumber: 9999, generation: 0 })).rejects.toThrow(
      'Invalid object number: 9999',
    );
  });
});

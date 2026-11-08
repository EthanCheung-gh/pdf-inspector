/**
 * Contract test for the raw PDF types and their transport wiring.
 *
 * The value below is a complete `RawDocument` / `RawObject` /
 * `RawPageContent`, so this file fails to typecheck if the shared contract in
 * `raw-pdf.ts` ever drifts from what the sidecar, the IPC bridge and the UI
 * expect. The assertions then pin the channel names and the two timeouts.
 */
import { describe, expect, it } from 'vitest';
import {
  IPC_CHANNELS,
  RAW_RENDERER_TIMEOUT_MS,
  RAW_TIMEOUT_MS,
} from '../../../shared/constants';
import type {
  RawContentStream,
  RawDocument,
  RawObject,
  RawPageContent,
  RawRef,
  RawValue,
} from '../raw-pdf';

const OBJECT_REF: RawRef = { objectNumber: 12, generation: 0 };

const STREAM_VALUE: RawValue = {
  kind: 'stream',
  dict: {
    kind: 'dict',
    entries: [
      { key: 'Type', value: { kind: 'name', value: 'XObject' } },
      { key: 'Length', value: { kind: 'number', value: 1024 } },
      { key: 'DecodeParms', value: { kind: 'null' } },
      { key: 'Flag', value: { kind: 'boolean', value: true } },
      { key: 'Label', value: { kind: 'string', value: 'image', truncated: false } },
      { key: 'Parent', value: { kind: 'ref', ref: OBJECT_REF } },
      {
        key: 'Kids',
        value: { kind: 'array', items: [{ kind: 'ref', ref: OBJECT_REF }], truncated: true },
      },
    ],
    truncated: false,
  },
  length: 1024,
  filters: ['FlateDecode'],
  preview: null,
  truncated: true,
};

const STREAM: RawContentStream = {
  ref: { objectNumber: 20, generation: 0 },
  length: 96,
  filters: [],
  operators: [
    {
      index: 0,
      offset: 0,
      operator: 'Tf',
      operands: [{ kind: 'name', value: 'F1' }, { kind: 'number', value: 12 }],
    },
    {
      index: 1,
      offset: 24,
      operator: 'Tj',
      operands: [{ kind: 'string', value: 'Hello', truncated: false }],
    },
  ],
  truncated: false,
  error: null,
};

const DOCUMENT: RawDocument = {
  pages: 3,
  version: '1.7',
  encrypted: false,
  roots: [
    { label: 'Root', ref: { objectNumber: 1, generation: 0 }, value: null },
    { label: 'Info', ref: { objectNumber: 2, generation: 0 }, value: null },
    { label: 'ID', ref: null, value: { kind: 'array', items: [], truncated: false } },
  ],
};

const OBJECT: RawObject = { ref: OBJECT_REF, value: STREAM_VALUE, summary: 'stream' };

const CONTENT: RawPageContent = { page: 1, streams: [STREAM], truncated: false };

describe('raw pdf contract', () => {
  it('keeps refs as explicit nodes instead of resolved objects', () => {
    const ref = (STREAM_VALUE as Extract<RawValue, { kind: 'stream' }>).dict;
    expect(ref.kind).toBe('dict');
    expect(OBJECT.ref).toEqual({ objectNumber: 12, generation: 0 });
    // A stream is metadata plus a bounded preview - never its bytes.
    expect(OBJECT.value).toMatchObject({ kind: 'stream', preview: null, length: 1024 });
  });

  it('keeps a document, an object and a page payload shape-stable', () => {
    expect(DOCUMENT.roots.map((root) => root.label)).toEqual(['Root', 'Info', 'ID']);
    expect(OBJECT.summary).toBe('stream');
    expect(CONTENT.streams[0].operators.map((operator) => operator.operator)).toEqual([
      'Tf',
      'Tj',
    ]);
  });

  it('exposes dedicated IPC channels for the raw readers', () => {
    expect(IPC_CHANNELS.RAW_DOCUMENT).toBe('pdf:raw-document');
    expect(IPC_CHANNELS.RAW_OBJECT).toBe('pdf:raw-object');
    expect(IPC_CHANNELS.RAW_PAGE_CONTENT).toBe('pdf:raw-page-content');
  });

  it('gives the raw requests their own budget with renderer headroom', () => {
    expect(RAW_TIMEOUT_MS).toBe(120_000);
    expect(RAW_RENDERER_TIMEOUT_MS).toBe(125_000);
    expect(RAW_RENDERER_TIMEOUT_MS).toBe(RAW_TIMEOUT_MS + 5_000);
  });
});

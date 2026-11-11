import { describe, expect, it } from 'vitest';
import type { AnnotationIndexResult, AnnotationIndexSummary } from '../annotation-index';
import type { PdfAnnotation } from '../../types/annotations';
import {
  ANNOTATION_CSV_HEADERS,
  ANNOTATION_EXPORT_SCHEMA_VERSION,
  ANNOTATION_EXPORT_TOOL,
  annotationIndexToCsv,
  annotationIndexToJson,
  annotationLinkStatus,
  groupAnnotationsByPage,
  suggestAnnotationFilename,
} from '../annotation-export';

const BOM = '\uFEFF';

/** Shared annotation defaults; each fixture only overrides what it shows. */
const base = {
  rect: { x0: 0, y0: 0, x1: 10, y1: 10 },
  title: null,
  contents: null,
  modificationDate: null,
  color: null,
  opacity: null,
  hidden: false,
  link: null,
  form: null,
} as const;

const externalLink: PdfAnnotation = {
  ...base,
  id: '1:link-external',
  page: 1,
  subtype: 'Link',
  kind: 'link',
  link: {
    url: 'https://example.com/a',
    unsafeUrl: 'https://example.com/a',
    internalPage: null,
    newWindow: false,
  },
};

const unsafeLink: PdfAnnotation = {
  ...base,
  id: '1:link-unsafe',
  page: 1,
  subtype: 'Link',
  kind: 'link',
  link: { url: null, unsafeUrl: 'javascript:alert(1)', internalPage: null, newWindow: false },
};

const internalLink: PdfAnnotation = {
  ...base,
  id: '2:link-internal',
  page: 2,
  subtype: 'Link',
  kind: 'link',
  link: { url: null, unsafeUrl: null, internalPage: 3, newWindow: false },
};

const unresolvedLink: PdfAnnotation = {
  ...base,
  id: '2:link-unresolved',
  page: 2,
  subtype: 'Link',
  kind: 'link',
  link: { url: null, unsafeUrl: null, internalPage: null, newWindow: false },
};

/** A choice field with two selected values and two options. */
const choiceWidget: PdfAnnotation = {
  ...base,
  id: '1:widget-choice',
  page: 1,
  subtype: 'Widget',
  kind: 'form',
  form: {
    fieldName: 'amount',
    fieldType: 'Ch',
    value: ['A', 'B'],
    defaultValue: null,
    readOnly: true,
    required: false,
    checkBox: false,
    radioButton: false,
    pushButton: false,
    multiLine: false,
    combo: true,
    options: [
      { label: 'Alpha', value: 'A' },
      { label: 'Beta', value: 'B' },
    ],
  },
};

const textWidget: PdfAnnotation = {
  ...base,
  id: '2:widget-text',
  page: 2,
  subtype: 'Widget',
  kind: 'form',
  form: {
    fieldName: 'name',
    fieldType: 'Tx',
    value: 'John',
    defaultValue: null,
    readOnly: false,
    required: true,
    checkBox: false,
    radioButton: false,
    pushButton: false,
    multiLine: false,
    combo: false,
    options: [],
  },
};

const note: PdfAnnotation = {
  ...base,
  id: '2:note',
  page: 2,
  subtype: 'Text',
  kind: 'note',
  contents: 'Please "review", the invoice',
};

const SUMMARY: AnnotationIndexSummary = {
  annotations: 7,
  pagesWithAnnotations: 2,
  links: 4,
  forms: 2,
  markup: 0,
  notes: 1,
  stamps: 0,
  other: 0,
  hidden: 0,
  unresolvedLinks: 1,
  unsafeLinks: 1,
  formFields: 2,
};

/**
 * One index holding every classification. The array is deliberately unsorted so
 * both serializers have to group by page themselves.
 */
const result: AnnotationIndexResult = {
  annotations: [
    note,
    externalLink,
    textWidget,
    unsafeLink,
    internalLink,
    choiceWidget,
    unresolvedLink,
  ],
  summary: SUMMARY,
  linkIssues: [
    {
      annotationId: '1:link-external',
      page: 1,
      subtype: 'Link',
      kind: 'external',
      target: 'https://example.com/a',
      message: 'External link to https://example.com/a',
    },
    {
      annotationId: '1:link-unsafe',
      page: 1,
      subtype: 'Link',
      kind: 'unsafe',
      target: 'javascript:alert(1)',
      message: 'Link uses an unsafe target scheme: javascript:alert(1)',
    },
    {
      annotationId: '2:link-unresolved',
      page: 2,
      subtype: 'Link',
      kind: 'unresolved',
      target: null,
      message: 'Link has no external URL and no resolved page',
    },
  ],
  formIssues: [
    {
      annotationId: '2:widget-text',
      fieldName: null,
      pages: [2],
      fieldTypes: ['Tx'],
      widgetCount: 1,
      kind: 'unnamed',
      message: 'Form widget has no field name',
    },
  ],
  formFields: [
    {
      name: 'amount',
      fieldType: 'Ch',
      pages: [1],
      widgetCount: 1,
      required: false,
      readOnly: true,
      values: ['A', 'B'],
    },
    {
      name: 'name',
      fieldType: 'Tx',
      pages: [2],
      widgetCount: 1,
      required: true,
      readOnly: false,
      values: ['John'],
    },
  ],
  scannedPages: 2,
  truncated: false,
};

const EMPTY_SUMMARY: AnnotationIndexSummary = {
  annotations: 0,
  pagesWithAnnotations: 0,
  links: 0,
  forms: 0,
  markup: 0,
  notes: 0,
  stamps: 0,
  other: 0,
  hidden: 0,
  unresolvedLinks: 0,
  unsafeLinks: 0,
  formFields: 0,
};

const emptyResult: AnnotationIndexResult = {
  annotations: [],
  summary: EMPTY_SUMMARY,
  linkIssues: [],
  formIssues: [],
  formFields: [],
  scannedPages: 0,
  truncated: false,
};

/** Lines of a CSV without the BOM. Fixtures here contain no embedded newline. */
function csvLines(csv: string): string[] {
  return csv.replace(/^\uFEFF/, '').split('\n');
}

/** Row index of `needle` inside the section that starts at `title`. */
function rowStartingWith(csv: string, needle: string): string | undefined {
  return csvLines(csv).find((line) => line.startsWith(needle));
}

/**
 * Split one RFC 4180 row into fields: doubled quotes unescape, a quoted comma
 * stays inside its field. Only used on rows known to have no embedded newline.
 */
function splitRow(row: string): string[] {
  const fields: string[] = [];
  let current = '';
  let quoted = false;

  for (let index = 0; index < row.length; index += 1) {
    const char = row[index];
    if (quoted) {
      if (char === '"' && row[index + 1] === '"') {
        current += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      fields.push(current);
      current = '';
    } else {
      current += char;
    }
  }

  fields.push(current);
  return fields;
}

/** Section body between `# <title>` (exclusive) and the next `# ` title. */
function sectionBody(csv: string, title: string): string[] {
  const lines = csvLines(csv);
  const start = lines.indexOf(`# ${title}`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('# '));
  return (end === -1 ? rest : rest.slice(0, end)).filter((line) => line.length > 0);
}

describe('groupAnnotationsByPage', () => {
  it('groups ascending by page and keeps the index order inside a page', () => {
    const groups = groupAnnotationsByPage([
      unresolvedLink,
      externalLink,
      note,
      unsafeLink,
    ]);

    expect(groups.map((group) => group.page)).toEqual([1, 2]);
    expect(groups[0].annotations.map((annotation) => annotation.id)).toEqual([
      '1:link-external',
      '1:link-unsafe',
    ]);
    expect(groups[1].annotations.map((annotation) => annotation.id)).toEqual([
      '2:link-unresolved',
      '2:note',
    ]);
  });

  it('returns nothing for a document without annotations', () => {
    expect(groupAnnotationsByPage([])).toEqual([]);
  });
});

describe('annotationIndexToJson', () => {
  const documentInfo = { name: '报告.pdf', sourceUrl: null, pages: 2 };

  it('writes the versioned envelope, document and summary', () => {
    const parsed = JSON.parse(annotationIndexToJson(result, documentInfo));

    expect(parsed.schemaVersion).toBe(ANNOTATION_EXPORT_SCHEMA_VERSION);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.tool).toEqual({ name: 'pdf-inspector', version: '0.2.0' });
    expect(parsed.tool).toEqual({ ...ANNOTATION_EXPORT_TOOL });
    expect(Number.isNaN(Date.parse(parsed.exportedAt))).toBe(false);
    expect(parsed.exportedAt.endsWith('Z')).toBe(true);
    expect(parsed.document).toEqual({ name: '报告.pdf', sourceUrl: null, pages: 2 });
    expect(parsed.summary).toEqual(SUMMARY);
  });

  it('groups annotations by page, ascending, and omits pages without any', () => {
    const parsed = JSON.parse(
      annotationIndexToJson(result, { name: null, sourceUrl: null, pages: 9 }),
    );

    // Page 3..9 of the document exist but carry no annotation.
    expect(parsed.pages.map((group: { page: number }) => group.page)).toEqual([1, 2]);
    expect(
      parsed.pages[0].annotations.map((annotation: { id: string }) => annotation.id),
    ).toEqual(['1:link-external', '1:link-unsafe', '1:widget-choice']);
    expect(
      parsed.pages[1].annotations.map((annotation: { id: string }) => annotation.id),
    ).toEqual(['2:note', '2:widget-text', '2:link-internal', '2:link-unresolved']);

    // The annotation payload is the normalized model, not a display projection.
    const widget = parsed.pages[0].annotations[2];
    expect(widget.rect).toEqual({ x0: 0, y0: 0, x1: 10, y1: 10 });
    expect(widget.form.fieldName).toBe('amount');
    expect(widget.form.options).toEqual([
      { label: 'Alpha', value: 'A' },
      { label: 'Beta', value: 'B' },
    ]);
  });

  it('carries the health check lists and merged form fields unchanged', () => {
    const parsed = JSON.parse(annotationIndexToJson(result, documentInfo));

    expect(parsed.linkIssues).toEqual(result.linkIssues);
    expect(parsed.formIssues).toEqual(result.formIssues);
    expect(parsed.formFields).toEqual(result.formFields);
  });

  it('exports an empty document without failing', () => {
    const parsed = JSON.parse(annotationIndexToJson(emptyResult, documentInfo));

    expect(parsed.pages).toEqual([]);
    expect(parsed.summary).toEqual(EMPTY_SUMMARY);
    expect(parsed.linkIssues).toEqual([]);
    expect(parsed.formFields).toEqual([]);
  });

  it('never writes a local disk path', () => {
    const json = annotationIndexToJson(result, {
      name: 'doc.pdf',
      sourceUrl: 'https://example.com/doc.pdf',
      pages: 2,
    });

    // The payload only knows the display name and the source URL: a caller's
    // local path (or the temp file a URL document is downloaded to) must not
    // leak into the export.
    expect(json).not.toContain('/tmp/');
    expect(json).not.toContain('C:\\');
    expect(json).not.toContain('/home/');
  });
});

describe('annotationIndexToCsv', () => {
  it('starts with a BOM and the three fixed sections in order', () => {
    const csv = annotationIndexToCsv(result);

    expect(csv.startsWith(BOM)).toBe(true);
    expect(csvLines(csv).slice(0, 2)).toEqual([
      '# annotations',
      ANNOTATION_CSV_HEADERS.annotations.join(','),
    ]);

    const titles = csvLines(csv).filter((line) => line.startsWith('# '));
    expect(titles).toEqual(['# annotations', '# links', '# form_fields']);

    expect(csvLines(csv)).toContain(ANNOTATION_CSV_HEADERS.links.join(','));
    expect(csvLines(csv)).toContain(ANNOTATION_CSV_HEADERS.formFields.join(','));

    // Same header order the plan documents.
    expect(ANNOTATION_CSV_HEADERS.annotations).toEqual([
      'page',
      'subtype',
      'kind',
      'rect',
      'hidden',
      'title',
      'contents',
      'target',
      'field_name',
      'field_type',
      'value',
      'options',
    ]);
    expect(ANNOTATION_CSV_HEADERS.links).toEqual([
      'page',
      'subtype',
      'url',
      'unsafe_url',
      'internal_page',
      'status',
    ]);
    expect(ANNOTATION_CSV_HEADERS.formFields).toEqual([
      'name',
      'field_type',
      'pages',
      'widget_count',
      'required',
      'read_only',
      'values',
    ]);
  });

  it('lists every annotation in page order with link/form columns filled', () => {
    const rows = sectionBody(annotationIndexToCsv(result), 'annotations').slice(1);

    expect(rows).toHaveLength(result.annotations.length);

    expect(splitRow(rows[0])).toEqual([
      '1',
      'Link',
      'link',
      // The rect is one quoted field, so it survives as a single CSV cell.
      '0,0,10,10',
      'false',
      '',
      '',
      'https://example.com/a',
      '',
      '',
      '',
      '',
    ]);
    expect(splitRow(rows[1])).toEqual([
      '1',
      'Link',
      'link',
      '0,0,10,10',
      'false',
      '',
      '',
      'javascript:alert(1)',
      '',
      '',
      '',
      '',
    ]);
    expect(splitRow(rows[2])).toEqual([
      '1',
      'Widget',
      'form',
      '0,0,10,10',
      'false',
      '',
      '',
      '',
      'amount',
      'Ch',
      'A; B',
      'Alpha=A; Beta=B',
    ]);
    expect(splitRow(rows[3])).toEqual([
      '2',
      'Text',
      'note',
      '0,0,10,10',
      'false',
      '',
      'Please "review", the invoice',
      '',
      '',
      '',
      '',
      '',
    ]);
    expect(splitRow(rows[4])).toEqual([
      '2',
      'Widget',
      'form',
      '0,0,10,10',
      'false',
      '',
      '',
      '',
      'name',
      'Tx',
      'John',
      '',
    ]);
    // An internal destination has no URL column of its own in this section.
    expect(splitRow(rows[5])[7]).toBe('');
  });

  it('quotes the rectangle as one field and joins arrays with "; "', () => {
    const csv = annotationIndexToCsv(result);

    // Four numbers inside a single quoted field, so the rect stays one cell.
    expect(csv).toContain('"0,0,10,10"');
    expect(csv).toContain(',A; B,');
    expect(csv).toContain('Alpha=A; Beta=B');
  });

  it('escapes quotes, commas and newlines as RFC 4180', () => {
    const csv = annotationIndexToCsv(result);

    expect(csv).toContain('"Please ""review"", the invoice"');

    const withNewline = annotationIndexToCsv({
      ...emptyResult,
      annotations: [{ ...note, contents: 'line one\nline two' }],
    });
    expect(withNewline).toContain('"line one\nline two"');
  });

  it('reports hidden annotations and a missing rectangle', () => {
    const csv = annotationIndexToCsv({
      ...emptyResult,
      annotations: [{ ...note, hidden: true, rect: null }],
    });

    const row = rowStartingWith(csv, '2,Text,note,') ?? '';
    // An unusable rectangle leaves an empty field instead of "null".
    expect(row.startsWith('2,Text,note,,true,')).toBe(true);
    expect(row).not.toContain('null');
    expect(row).not.toContain('undefined');
  });

  it('classifies every link in the links section', () => {
    const rows = sectionBody(annotationIndexToCsv(result), 'links').slice(1);

    expect(rows).toEqual([
      '1,Link,https://example.com/a,https://example.com/a,,external',
      '1,Link,,javascript:alert(1),,unsafe',
      '2,Link,,,3,internal',
      '2,Link,,,,unresolved',
    ]);
  });

  it('lists unique form fields with their pages and values', () => {
    const rows = sectionBody(annotationIndexToCsv(result), 'form_fields').slice(1);

    expect(rows).toEqual(['amount,Ch,1,1,false,true,A; B', 'name,Tx,2,1,true,false,John']);
  });

  it('keeps the three sections for an empty document', () => {
    const csv = annotationIndexToCsv(emptyResult);

    expect(csv).toBe(
      `${BOM}# annotations\n${ANNOTATION_CSV_HEADERS.annotations.join(',')}\n` +
        `# links\n${ANNOTATION_CSV_HEADERS.links.join(',')}\n` +
        `# form_fields\n${ANNOTATION_CSV_HEADERS.formFields.join(',')}\n`,
    );
  });
});

describe('annotationLinkStatus', () => {
  it('prefers a safe URL, then an unsafe scheme, then an internal page', () => {
    expect(annotationLinkStatus(externalLink.link!)).toBe('external');
    expect(annotationLinkStatus(unsafeLink.link!)).toBe('unsafe');
    expect(annotationLinkStatus(internalLink.link!)).toBe('internal');
    expect(annotationLinkStatus(unresolvedLink.link!)).toBe('unresolved');

    // A refused target with an http(s) scheme is not "unsafe": the resolver just
    // did not resolve it to a page.
    expect(
      annotationLinkStatus({
        url: null,
        unsafeUrl: 'https://example.com/raw',
        internalPage: null,
        newWindow: false,
      }),
    ).toBe('unresolved');

    // mailto/file/data are all refused schemes.
    for (const target of ['mailto:a@b.c', 'file:///etc/passwd', 'data:text/html,x']) {
      expect(
        annotationLinkStatus({
          url: null,
          unsafeUrl: target,
          internalPage: null,
          newWindow: false,
        }),
      ).toBe('unsafe');
    }
  });
});

describe('suggestAnnotationFilename', () => {
  it('replaces the document scope suffix with the annotation one', () => {
    expect(suggestAnnotationFilename('doc.pdf', null, '/tmp/doc.pdf', 'json')).toBe(
      'doc-annotations.json',
    );
    expect(suggestAnnotationFilename('doc.pdf', null, '/tmp/doc.pdf', 'csv')).toBe(
      'doc-annotations.csv',
    );
  });

  it('keeps Unicode names', () => {
    expect(suggestAnnotationFilename('报告 2024.pdf', null, '/tmp/x.pdf', 'json')).toBe(
      '报告 2024-annotations.json',
    );
    // The display name is already decoded by the bridge; a literal %20 stays.
    expect(suggestAnnotationFilename('a%20b.pdf', null, null, 'json')).toBe(
      'a%20b-annotations.json',
    );
  });

  it('prefers the source URL and decodes its last segment', () => {
    expect(
      suggestAnnotationFilename(
        null,
        'http://localhost:8080/doc/x/%E6%B5%8B%E8%AF%95%20report.pdf?token=1',
        '/tmp/tmp-1a2b.pdf',
        'csv',
      ),
    ).toBe('测试 report-annotations.csv');
  });

  it('does not leak a temp file name when the display name is known', () => {
    expect(suggestAnnotationFilename('测试 报告.pdf', null, '/tmp/_____-1a2b.pdf', 'json')).toBe(
      '测试 报告-annotations.json',
    );
  });

  it('falls back to a generic name when nothing usable is known', () => {
    expect(suggestAnnotationFilename(null, null, null, 'csv')).toBe('document-annotations.csv');
    expect(suggestAnnotationFilename(null, null, '/tmp/_____', 'json')).toBe(
      'document-annotations.json',
    );
  });
});

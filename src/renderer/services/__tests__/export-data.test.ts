import { describe, expect, it } from 'vitest';
import type { PageData, PdfMetadata, PdfObject, PdfObjectType } from '../../types/pdf-objects';
import {
  EXPORT_OBJECT_TYPES,
  objectsToCsv,
  objectsToJson,
  pagesToCsv,
  pagesToJson,
  suggestFilename,
} from '../export-data';

const metadata: PdfMetadata = {
  pages: 1, version: '1.7', encrypted: false, page_w: 612, page_h: 792,
  title: 'Demo', author: 'A', producer: 'P', fonts: ['F1'],
};

function makePage(): PageData {
  return {
    width: 612,
    height: 792,
    chars: [{
      type: 'char', x0: 1, y0: 2, x1: 3, y1: 4, page: 1,
      text: 'a,"b\nc', fontname: 'F1', size: 12, color: '#000000',
    }],
    words: [{
      type: 'word', x0: 1, y0: 2, x1: 9, y1: 4, page: 1,
      text: 'hello', fontname: 'F1', size: 12,
    }],
    rects: [{
      type: 'rect', x0: 0, y0: 0, x1: 10, y1: 10, page: 1,
      fill: true, stroke: false, color: '#ff0000', width: 1,
    }],
    lines: [{
      type: 'line', x0: 0, y0: 0, x1: 10, y1: 0, page: 1,
      stroke: true, color: '#00ff00', width: 0.5,
    }],
    curves: [{
      type: 'curve', x0: 0, y0: 0, x1: 5, y1: 5, page: 1,
      points: [[0, 0], [5, 5]], stroke: true,
    }],
    images: [{
      type: 'image', x0: 0, y0: 0, x1: 20, y1: 20, page: 1,
      width: 20, height: 20, stream_id: 'p1_img_0', format: 'png',
    }],
    tables: [{
      type: 'table', x0: 0, y0: 0, x1: 50, y1: 50, page: 1,
      rows: 2, cols: 2, cells: [['h1', 'h2'], ['v1', 'v2']],
    }],
  };
}

/** Section titles in the order they appear, with the BOM stripped from the first line. */
function sectionTitles(csv: string): string[] {
  return csv
    .split('\n')
    .map((line) => line.replace(/^\uFEFF/, ''))
    .filter((line) => line.startsWith('# '));
}

function makeTablePage(page: number, text: string): PageData {
  return {
    width: 612,
    height: 792,
    chars: [],
    words: [],
    rects: [],
    lines: [],
    curves: [],
    images: [],
    tables: [{
      type: 'table', x0: 0, y0: 0, x1: 10, y1: 10, page,
      rows: 1, cols: 1, cells: [[text]],
    }],
  };
}

describe('pagesToJson', () => {
  it('produces parseable JSON with metadata, pageCount and pages', () => {
    const parsed = JSON.parse(pagesToJson([makePage()], metadata));
    expect(parsed.metadata).toEqual(metadata);
    expect(parsed.pageCount).toBe(1);
    expect(parsed.pages).toHaveLength(1);
    expect(parsed.pages[0].chars[0].text).toBe('a,"b\nc');
    expect(typeof parsed.exportedAt).toBe('string');
  });

  it('includes every object type by default, undefined or an explicit all-types list', () => {
    const implicit = JSON.parse(pagesToJson([makePage()], metadata));
    const explicitUndefined = JSON.parse(pagesToJson([makePage()], metadata, undefined));
    const explicitAll = JSON.parse(pagesToJson([makePage()], metadata, EXPORT_OBJECT_TYPES));

    expect(implicit.objectTypes).toEqual(EXPORT_OBJECT_TYPES);
    expect(explicitUndefined.objectTypes).toEqual(EXPORT_OBJECT_TYPES);
    expect(explicitAll.objectTypes).toEqual(EXPORT_OBJECT_TYPES);
    expect(explicitUndefined.pages).toEqual(implicit.pages);
    expect(explicitAll.pages).toEqual(implicit.pages);
    for (const key of ['chars', 'words', 'rects', 'lines', 'curves', 'images', 'tables']) {
      expect(implicit.pages[0][key].length).toBeGreaterThan(0);
    }
  });

  it('keeps only the selected arrays and reports them in canonical order', () => {
    const parsed = JSON.parse(pagesToJson([makePage()], metadata, ['table', 'word']));
    const page = parsed.pages[0];

    expect(parsed.metadata).toEqual(metadata);
    expect(parsed.pageCount).toBe(1);
    expect(parsed.objectTypes).toEqual(['word', 'table']);
    expect(page.width).toBe(612);
    expect(page.height).toBe(792);
    expect(page.words).toHaveLength(1);
    expect(page.words[0].text).toBe('hello');
    expect(page.tables).toHaveLength(1);
    expect(page.tables[0].cells[1][1]).toBe('v2');
    for (const key of ['chars', 'rects', 'lines', 'curves', 'images']) {
      expect(page[key]).toEqual([]);
    }
  });

  it('treats an explicit empty selection as no object data, not all types', () => {
    const parsed = JSON.parse(pagesToJson([makePage()], metadata, []));
    const page = parsed.pages[0];

    expect(parsed.objectTypes).toEqual([]);
    expect(parsed.pageCount).toBe(1);
    expect(page.width).toBe(612);
    expect(page.height).toBe(792);
    for (const key of ['chars', 'words', 'rects', 'lines', 'curves', 'images', 'tables']) {
      expect(page[key]).toEqual([]);
    }
  });

  it('ignores unknown type strings and de-duplicates selections', () => {
    const parsed = JSON.parse(
      pagesToJson([makePage()], metadata, ['char', 'bogus' as PdfObjectType, 'char']),
    );
    expect(parsed.objectTypes).toEqual(['char']);
    expect(parsed.pages[0].chars).toHaveLength(1);
    expect(parsed.pages[0].words).toEqual([]);
  });
});

describe('pagesToCsv', () => {
  const csv = pagesToCsv([makePage()]);

  it('starts with a UTF-8 BOM so Excel decodes non-ASCII text', () => {
    expect(csv.charCodeAt(0)).toBe(0xfeff);
  });

  it('contains one section per object type in order', () => {
    const sections = ['# chars', '# words', '# rects', '# lines', '# curves', '# images', '# tables'];
    let last = -1;
    for (const section of sections) {
      const at = csv.indexOf(section);
      expect(at).toBeGreaterThan(last);
      last = at;
    }
  });

  it('escapes comma, quote and newline per RFC 4180', () => {
    // a,"b\nc  →  "a,""b
    expect(csv).toContain('"a,""b\nc"');
  });

  it('writes chars header and row with page prefix', () => {
    expect(csv).toContain('page,x0,y0,x1,y1,text,fontname,size,color');
    expect(csv).toContain('1,1,2,3,4,"a,""b');
  });

  it('flattens table cells as page,table_index,row,col,text', () => {
    expect(csv).toContain('page,table_index,row,col,text');
    expect(csv).toContain('1,0,0,0,h1');
    expect(csv).toContain('1,0,1,1,v2');
  });

  it('serializes curve points as JSON', () => {
    expect(csv).toContain('"[[0,0],[5,5]]"');
  });

  it('keeps the full output for undefined and explicit all-types calls', () => {
    const pages = [makePage()];
    expect(pagesToCsv(pages, undefined)).toBe(csv);
    expect(pagesToCsv(pages, EXPORT_OBJECT_TYPES)).toBe(csv);
  });

  it('emits only the selected sections, in canonical order', () => {
    const subsetCsv = pagesToCsv([makePage()], ['table', 'word']);

    expect(subsetCsv.charCodeAt(0)).toBe(0xfeff);
    expect(sectionTitles(subsetCsv)).toEqual(['# words', '# tables']);
    expect(subsetCsv).toContain('page,x0,y0,x1,y1,text,fontname,size');
    expect(subsetCsv).toContain('1,1,2,9,4,hello,F1,12');
    expect(subsetCsv).toContain('1,0,1,1,v2');
    for (const omitted of ['# chars', '# rects', '# lines', '# curves', '# images']) {
      expect(subsetCsv).not.toContain(omitted);
    }
  });

  it('returns only the BOM when the selection is explicitly empty', () => {
    expect(pagesToCsv([makePage()], [])).toBe('\uFEFF');
  });

  it('ignores unknown types', () => {
    expect(pagesToCsv([makePage()], ['bogus' as PdfObjectType])).toBe('\uFEFF');
  });

  it('restarts table_index for each page', () => {
    const multiPageCsv = pagesToCsv([makeTablePage(1, 'a'), makeTablePage(2, 'b')], ['table']);

    expect(sectionTitles(multiPageCsv)).toEqual(['# tables']);
    expect(multiPageCsv).toContain('1,0,0,0,a');
    expect(multiPageCsv).toContain('2,0,0,0,b');
  });
});

describe('suggestFilename', () => {
  it('builds page-scoped and document-scoped names', () => {
    expect(suggestFilename('/docs/report.pdf', 'page', 3, 'json')).toBe('report-p3.json');
    expect(suggestFilename('C:\\docs\\report.pdf', 'document', 1, 'csv')).toBe('report-all.csv');
  });

  it('handles missing path and non-pdf extension', () => {
    expect(suggestFilename(null, 'page', 1, 'json')).toBe('document-p1.json');
    expect(suggestFilename('/a/b.txt', 'document', 1, 'csv')).toBe('b.txt-all.csv');
  });

  it('keeps the local basename when no source URL is given', () => {
    expect(suggestFilename('/tmp/report-1a2b3c4d.pdf', 'page', 2, 'json', null)).toBe(
      'report-1a2b3c4d-p2.json',
    );
    expect(suggestFilename('/tmp/report-1a2b3c4d.pdf', 'document', 1, 'csv', undefined)).toBe(
      'report-1a2b3c4d-all.csv',
    );
  });

  it('prefers the URL stem over the temp file name', () => {
    expect(
      suggestFilename('/tmp/report-1a2b3c4d.pdf', 'page', 1, 'json', 'https://example.com/docs/report.pdf'),
    ).toBe('report-p1.json');
    expect(
      suggestFilename('/tmp/report-1a2b3c4d.pdf', 'document', 1, 'csv', 'https://example.com/docs/report.PDF'),
    ).toBe('report-all.csv');
  });

  it('strips query and hash and decodes the URL segment', () => {
    expect(
      suggestFilename(
        '/tmp/My%20Report-1a2b3c4d.pdf',
        'page',
        4,
        'csv',
        'https://example.com/files/My%20Report.pdf?token=abc#page=4',
      ),
    ).toBe('My Report-p4.csv');
  });

  it('falls back to the temp basename when the URL has no file name', () => {
    expect(suggestFilename('/tmp/Q1-9f8e7d6c.pdf', 'document', 1, 'json', 'https://example.com/')).toBe(
      'Q1-9f8e7d6c-all.json',
    );
    expect(
      suggestFilename('/tmp/Q1-9f8e7d6c.pdf', 'page', 2, 'csv', 'https://example.com/downloads/'),
    ).toBe('Q1-9f8e7d6c-p2.csv');
  });

  it('does not throw on malformed percent-encoding and falls back to the temp basename', () => {
    expect(() =>
      suggestFilename('/tmp/report-1a2b3c4d.pdf', 'page', 1, 'json', 'https://example.com/bad%E0%A4%A.pdf'),
    ).not.toThrow();
    expect(
      suggestFilename('/tmp/report-1a2b3c4d.pdf', 'page', 1, 'json', 'https://example.com/bad%E0%A4%A.pdf'),
    ).toBe('report-1a2b3c4d-p1.json');
  });

  it('does not let an encoded path separator escape into the filename', () => {
    expect(
      suggestFilename('/tmp/report-1a2b3c4d.pdf', 'page', 1, 'json', 'https://example.com/a%2Fb.pdf'),
    ).toBe('a_b-p1.json');
  });
});

const objects: PdfObject[] = [
  { type: 'char', x0: 0, y0: 1, x1: 2, y1: 3, page: 2, text: 'hi, "there"', fontname: 'Helvetica', size: 12, color: '#000000' },
  { type: 'rect', x0: 4, y0: 5, x1: 6, y1: 7, page: 2, fill: true, stroke: false, color: '#ff0000', width: 1 },
];

describe('objectsToJson', () => {
  it('emits metadata, page, objectCount and objects', () => {
    const parsed = JSON.parse(objectsToJson(objects, null, 2));
    expect(parsed.page).toBe(2);
    expect(parsed.objectCount).toBe(2);
    expect(parsed.objects[0].text).toBe('hi, "there"');
  });

  it('reports every type in canonical order by default', () => {
    const parsed = JSON.parse(objectsToJson(objects, null, 2, undefined));
    expect(parsed.objectTypes).toEqual(EXPORT_OBJECT_TYPES);
    expect(parsed.objectCount).toBe(objects.length);
  });

  it('filters objects and updates objectCount/objectTypes', () => {
    const parsed = JSON.parse(objectsToJson(objects, null, 2, ['rect']));
    expect(parsed.page).toBe(2);
    expect(parsed.objectCount).toBe(1);
    expect(parsed.objectTypes).toEqual(['rect']);
    expect(parsed.objects).toHaveLength(1);
    expect(parsed.objects[0].type).toBe('rect');
  });

  it('treats an explicit empty selection as no objects', () => {
    const parsed = JSON.parse(objectsToJson(objects, null, 2, []));
    expect(parsed.objectCount).toBe(0);
    expect(parsed.objectTypes).toEqual([]);
    expect(parsed.objects).toEqual([]);
  });
});

describe('objectsToCsv', () => {
  it('uses the same section headers as pagesToCsv with page-prefixed rows', () => {
    const csv = objectsToCsv(objects, 2);
    expect(csv).toContain('# chars');
    expect(csv).toContain('# rects');
    // RFC 4180: text containing comma + quotes is escaped.
    expect(csv).toContain('2,0,1,2,3,"hi, ""there"""');
    // No table objects: '# tables' section is header-only (same layout as pagesToCsv).
    expect(csv.endsWith('# tables\npage,table_index,row,col,text\n')).toBe(true);
  });

  it('emits all sections by default and for explicit all-types calls', () => {
    const allTitles = ['# chars', '# words', '# rects', '# lines', '# curves', '# images', '# tables'];
    expect(sectionTitles(objectsToCsv(objects, 2))).toEqual(allTitles);
    expect(sectionTitles(objectsToCsv(objects, 2, EXPORT_OBJECT_TYPES))).toEqual(allTitles);
  });

  it('emits only the selected sections and their rows', () => {
    const csv = objectsToCsv(objects, 2, ['rect']);
    expect(sectionTitles(csv)).toEqual(['# rects']);
    expect(csv).toContain('2,4,5,6,7,true,false,#ff0000,1');
    expect(csv).not.toContain('# chars');
    expect(csv).not.toContain('# tables');
  });

  it('returns only the BOM when the selection is explicitly empty or invalid', () => {
    expect(objectsToCsv(objects, 2, [])).toBe('\uFEFF');
    expect(objectsToCsv(objects, 2, ['bogus' as PdfObjectType])).toBe('\uFEFF');
  });
});

import { describe, expect, it } from 'vitest';
import type { PageData, PdfMetadata } from '../../types/pdf-objects';
import { pagesToCsv, pagesToJson, suggestFilename } from '../export-data';

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

describe('pagesToJson', () => {
  it('produces parseable JSON with metadata, pageCount and pages', () => {
    const parsed = JSON.parse(pagesToJson([makePage()], metadata));
    expect(parsed.metadata).toEqual(metadata);
    expect(parsed.pageCount).toBe(1);
    expect(parsed.pages).toHaveLength(1);
    expect(parsed.pages[0].chars[0].text).toBe('a,"b\nc');
    expect(typeof parsed.exportedAt).toBe('string');
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
});

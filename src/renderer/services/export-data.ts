import type { PageData, PdfMetadata } from '../types/pdf-objects';

export function pagesToJson(pages: PageData[], metadata: PdfMetadata | null): string {
  return JSON.stringify(
    {
      metadata,
      exportedAt: new Date().toISOString(),
      pageCount: pages.length,
      pages,
    },
    null,
    2,
  );
}

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function csvRow(values: (string | number | boolean)[]): string {
  return values.map((v) => csvEscape(String(v))).join(',');
}

const BBOX = ['page', 'x0', 'y0', 'x1', 'y1'] as const;

/** Single CSV file, one `# <type>` section per object type. BOM-prefixed so Excel decodes UTF-8 correctly. */
export function pagesToCsv(pages: PageData[]): string {
  const out: string[] = [];

  out.push('# chars');
  out.push(csvRow([...BBOX, 'text', 'fontname', 'size', 'color']));
  for (const page of pages) {
    for (const c of page.chars) {
      out.push(csvRow([c.page, c.x0, c.y0, c.x1, c.y1, c.text, c.fontname, c.size, c.color]));
    }
  }

  out.push('# words');
  out.push(csvRow([...BBOX, 'text', 'fontname', 'size']));
  for (const page of pages) {
    for (const w of page.words) {
      out.push(csvRow([w.page, w.x0, w.y0, w.x1, w.y1, w.text, w.fontname, w.size]));
    }
  }

  out.push('# rects');
  out.push(csvRow([...BBOX, 'fill', 'stroke', 'color', 'width']));
  for (const page of pages) {
    for (const r of page.rects) {
      out.push(csvRow([r.page, r.x0, r.y0, r.x1, r.y1, r.fill, r.stroke, r.color, r.width]));
    }
  }

  out.push('# lines');
  out.push(csvRow([...BBOX, 'stroke', 'color', 'width']));
  for (const page of pages) {
    for (const l of page.lines) {
      out.push(csvRow([l.page, l.x0, l.y0, l.x1, l.y1, l.stroke, l.color, l.width]));
    }
  }

  out.push('# curves');
  out.push(csvRow([...BBOX, 'points', 'stroke']));
  for (const page of pages) {
    for (const c of page.curves) {
      out.push(csvRow([c.page, c.x0, c.y0, c.x1, c.y1, JSON.stringify(c.points), c.stroke]));
    }
  }

  out.push('# images');
  out.push(csvRow([...BBOX, 'width', 'height', 'stream_id', 'format']));
  for (const page of pages) {
    for (const img of page.images) {
      out.push(
        csvRow([img.page, img.x0, img.y0, img.x1, img.y1, img.width, img.height, img.stream_id, img.format]),
      );
    }
  }

  out.push('# tables');
  out.push(csvRow(['page', 'table_index', 'row', 'col', 'text']));
  for (const page of pages) {
    page.tables.forEach((t, tableIndex) => {
      t.cells.forEach((row, rowIndex) => {
        row.forEach((text, colIndex) => {
          out.push(csvRow([t.page, tableIndex, rowIndex, colIndex, text]));
        });
      });
    });
  }

  // ﻿ prefix so Excel decodes non-ASCII text as UTF-8.
  return `﻿${out.join('\n')}\n`;
}

export function suggestFilename(
  pdfPath: string | null,
  scope: 'page' | 'document',
  page: number,
  ext: 'json' | 'csv',
): string {
  const base = (pdfPath?.split(/[\\/]/).pop() ?? 'document').replace(/\.pdf$/i, '');
  return scope === 'page' ? `${base}-p${page}.${ext}` : `${base}-all.${ext}`;
}

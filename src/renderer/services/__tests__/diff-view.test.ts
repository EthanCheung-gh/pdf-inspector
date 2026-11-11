import { describe, expect, it } from 'vitest';
import {
  DIFF_BOX_COLORS,
  buildDiffPageGroups,
  clampDiffZoom,
  collectOverlayBoxes,
  collectPageBoxes,
  computeDiffFitZoom,
  countFilteredChanges,
  describeDiffDetails,
  diffBoxRects,
  diffChangePreview,
  diffPageLabel,
  firstInterestingPageIndex,
  isDiffResultEmpty,
  isPageGeometryChange,
  pageGeometrySummary,
  projectDiffBBox,
  resolveDiffPageJump,
  suggestDiffJsonFilename,
  tableCellChanges,
  type DiffBoxSpec,
} from '../diff-view';
import {
  makeChange,
  makeIdenticalResult,
  makePage,
  makeResult,
  makeSampleResult,
} from './diff-fixtures';

const DEFAULT_FILTER = { kind: 'all', type: 'all' } as const;

describe('buildDiffPageGroups', () => {
  it('groups changes per page and keeps one-sided pages while unfiltered', () => {
    const groups = buildDiffPageGroups(makeSampleResult().pages, DEFAULT_FILTER);

    expect(groups.map((group) => group.pageIndex)).toEqual([0, 1, 2]);
    expect(groups[0].changes.map((entry) => entry.change.kind)).toEqual(['modified', 'removed']);
    expect(groups[1].page.status).toBe('removed');
    expect(groups[2].page.status).toBe('added');
  });

  it('skips unchanged pages entirely', () => {
    const groups = buildDiffPageGroups(makeIdenticalResult().pages, DEFAULT_FILTER);
    expect(groups).toEqual([]);
  });

  it('filters by kind and type, dropping empty page groups', () => {
    const pages = makeSampleResult().pages;

    const removed = buildDiffPageGroups(pages, { kind: 'removed', type: 'all' });
    expect(removed.map((group) => group.pageIndex)).toEqual([0, 1]);
    expect(removed[0].changes).toHaveLength(1);
    expect(removed[0].changes[0].change.type).toBe('rect');

    const words = buildDiffPageGroups(pages, { kind: 'all', type: 'word' });
    expect(words.map((group) => group.pageIndex)).toEqual([0, 1, 2]);
    expect(words.every((group) => group.changes.every((entry) => entry.change.type === 'word'))).toBe(
      true,
    );
  });

  it('hides empty one-sided pages once a filter is active', () => {
    const pages = [makePage({ oldIndex: 2, newIndex: null, status: 'removed', newSize: null, changes: [] })];

    expect(buildDiffPageGroups(pages, DEFAULT_FILTER)).toHaveLength(1);
    expect(buildDiffPageGroups(pages, { kind: 'added', type: 'all' })).toHaveLength(0);
  });

  it('counts filtered changes across pages', () => {
    const pages = makeSampleResult().pages;

    expect(countFilteredChanges(pages, DEFAULT_FILTER)).toBe(4);
    expect(countFilteredChanges(pages, { kind: 'added', type: 'all' })).toBe(1);
    expect(countFilteredChanges(pages, { kind: 'all', type: 'table' })).toBe(0);
  });
});

describe('result level helpers', () => {
  it('finds the first page that is not unchanged', () => {
    const pages = [
      makePage({ status: 'unchanged' }),
      makePage({ oldIndex: 2, newIndex: 2, status: 'changed' }),
    ];

    expect(firstInterestingPageIndex(pages)).toBe(1);
    expect(firstInterestingPageIndex([])).toBe(0);
  });

  it('detects a diff with no differences at all', () => {
    expect(isDiffResultEmpty(makeIdenticalResult().pages)).toBe(true);
    expect(isDiffResultEmpty(makeSampleResult().pages)).toBe(false);
  });

  it('recognises page geometry pseudo-rectangles', () => {
    const geometry = makeChange({
      type: 'rect',
      details: { pageGeometry: { size: { old: { width: 612, height: 792 }, new: { width: 595, height: 842 } } } },
    });

    expect(isPageGeometryChange(geometry)).toBe(true);
    expect(isPageGeometryChange(makeChange())).toBe(false);
  });
});

describe('collectPageBoxes', () => {
  it('collects the boxes of one side with that side page size as space', () => {
    const page = makePage({
      oldSize: { width: 600, height: 800 },
      newSize: { width: 300, height: 400 },
      changes: [makeChange(), makeChange({ kind: 'removed', oldPage: 1, newPage: null, newBBox: null })],
    });

    const oldBoxes = collectPageBoxes(page, 'old', null, 0);
    expect(oldBoxes).toHaveLength(2);
    expect(oldBoxes.map((box) => box.kind)).toEqual(['modified', 'removed']);
    expect(oldBoxes[0].space).toEqual({ width: 600, height: 800 });
    expect(oldBoxes[0].side).toBe('old');

    // The new side only has a bbox for the modified change.
    const newBoxes = collectPageBoxes(page, 'new', null, 0);
    expect(newBoxes).toHaveLength(1);
    expect(newBoxes[0].space).toEqual({ width: 300, height: 400 });
  });

  it('skips page geometry changes and changes without a bbox', () => {
    const page = makePage({
      changes: [
        makeChange({ details: { pageGeometry: { rotation: { old: 0, new: 90 } } } }),
        makeChange({ oldBBox: null, newBBox: null }),
      ],
    });

    expect(collectPageBoxes(page, 'old', null, 0)).toEqual([]);
    expect(collectPageBoxes(page, 'new', null, 0)).toEqual([]);
  });

  it('returns nothing for a side that has no page', () => {
    const added = makePage({ oldIndex: null, oldSize: null, status: 'added', match: null });
    expect(collectPageBoxes(added, 'old', null, 0)).toEqual([]);
  });

  it('emits the selected box last and marks it', () => {
    const page = makePage({ changes: [makeChange(), makeChange({ kind: 'removed' })] });

    const boxes = collectPageBoxes(page, 'old', { pageIndex: 0, changeIndex: 0 }, 0);

    expect(boxes.map((box) => box.selected)).toEqual([false, true]);
    expect(boxes[1].key).toBe('0:0:old');
  });

  it('combines both sides for overlay mode', () => {
    const page = makePage({ changes: [makeChange()] });
    const boxes = collectOverlayBoxes(page, null, 0);

    expect(boxes.map((box) => box.side)).toEqual(['old', 'new']);
  });
});

describe('projectDiffBBox', () => {
  it('flips PDF y into canvas y and scales to the rendered page', () => {
    const rect = projectDiffBBox(
      { x0: 10, y0: 700, x1: 60, y1: 712 },
      { width: 612, height: 792 },
      612,
      792,
    );

    expect(rect).toEqual({ x: 10, y: 792 - 712, width: 50, height: 12 });
  });

  it('scales a different page size into the same canvas', () => {
    const rect = projectDiffBBox(
      { x0: 0, y0: 0, x1: 100, y1: 100 },
      { width: 200, height: 200 },
      400,
      400,
    );

    expect(rect).toEqual({ x: 0, y: 400 - 200, width: 200, height: 200 });
  });

  it('refuses unusable geometry instead of producing NaN rectangles', () => {
    const bbox = { x0: 0, y0: 0, x1: 10, y1: 10 };
    expect(projectDiffBBox(bbox, { width: 0, height: 0 }, 100, 100)).toBeNull();
    expect(projectDiffBBox(bbox, { width: 100, height: 100 }, 0, 100)).toBeNull();
    expect(
      projectDiffBBox({ x0: Number.NaN, y0: 0, x1: 10, y1: 10 }, { width: 100, height: 100 }, 10, 10),
    ).toBeNull();
  });

  it('maps box specs to coloured canvas rectangles', () => {
    const boxes: DiffBoxSpec[] = [
      {
        key: 'a',
        kind: 'added',
        side: 'new',
        bbox: { x0: 0, y0: 0, x1: 10, y1: 10 },
        space: { width: 10, height: 10 },
        selected: true,
      },
    ];

    const rects = diffBoxRects(boxes, 100, 100);

    expect(rects).toHaveLength(1);
    expect(rects[0].color).toBe(DIFF_BOX_COLORS.new.added);
    expect(rects[0]).toMatchObject({ x: 0, y: 0, width: 100, height: 100, selected: true });
  });

  it('uses red for removed and orange for moved on the old side', () => {
    expect(DIFF_BOX_COLORS.old.removed).toMatch(/^#ff/);
    expect(DIFF_BOX_COLORS.old.moved).toMatch(/^#ff/);
    expect(DIFF_BOX_COLORS.old.modified).toMatch(/^#4b/);
    expect(DIFF_BOX_COLORS.new.added).toMatch(/^#3e/);
  });
});

describe('zoom helpers', () => {
  it('fits the widest page into the available pane width', () => {
    // 600px pane, 32px padding -> 568 / 612.
    expect(computeDiffFitZoom(600, [612, 612])).toBeCloseTo(568 / 612, 5);
  });

  it('falls back to 100% when nothing can be measured', () => {
    expect(computeDiffFitZoom(0, [612])).toBe(1);
    expect(computeDiffFitZoom(600, [])).toBe(1);
    expect(computeDiffFitZoom(600, [Number.NaN])).toBe(1);
  });

  it('clamps zoom to the viewport range', () => {
    expect(clampDiffZoom(12)).toBe(5);
    expect(clampDiffZoom(0)).toBe(0.25);
    expect(clampDiffZoom(Number.NaN)).toBe(1);
  });
});

describe('labels and previews', () => {
  it('labels paired, added and removed pages', () => {
    expect(diffPageLabel(makePage())).toBe('Page 1');
    expect(diffPageLabel(makePage({ oldIndex: 2, newIndex: 3 }))).toBe('Old 2 → New 3');
    expect(diffPageLabel(makePage({ oldIndex: null, newIndex: 4, status: 'added' }))).toBe(
      'New page 4',
    );
    expect(diffPageLabel(makePage({ oldIndex: 5, newIndex: null, status: 'removed' }))).toBe(
      'Old page 5',
    );
  });

  it('previews text, geometry and box-only changes', () => {
    expect(diffChangePreview(makeChange())).toBe('Hello world');
    expect(diffChangePreview(makeChange({ textOld: 'Old  text', textNew: null }))).toBe('Old text');
    expect(
      diffChangePreview(makeChange({ details: { pageGeometry: {} }, textOld: null, textNew: null })),
    ).toBe('Page size / rotation changed');
    expect(diffChangePreview(makeChange({ textOld: null, textNew: null }))).toBe(
      '10, 700 → 60, 712',
    );
  });
});

describe('change details', () => {
  it('turns old/new pairs into labelled rows', () => {
    const rows = describeDiffDetails(
      makeChange({
        details: {
          fontName: { old: 'Helvetica', new: 'Times' },
          fontSize: { old: 10, new: 12.5 },
          stroke: { old: true, new: false },
        },
      }),
    );

    expect(rows).toEqual([
      { label: 'Font', oldValue: 'Helvetica', newValue: 'Times' },
      { label: 'Size', oldValue: '10', newValue: '12.5' },
      { label: 'Stroke', oldValue: 'yes', newValue: 'no' },
    ]);
  });

  it('formats page sizes and skips cell/geometry entries', () => {
    const rows = describeDiffDetails(
      makeChange({
        details: {
          size: { old: { width: 100, height: 50 }, new: { width: 120, height: 60 } },
          cellChanges: [{ row: 0, col: 0, old: 'a', new: 'b' }],
          pageGeometry: { size: { old: {}, new: {} } },
        },
      }),
    );

    expect(rows).toEqual([{ label: 'Size', oldValue: '100 × 50', newValue: '120 × 60' }]);
    expect(rows.some((row) => row.label === 'cellChanges')).toBe(false);
  });

  it('validates table cell changes and ignores malformed entries', () => {
    const cells = tableCellChanges(
      makeChange({
        type: 'table',
        details: {
          cellChanges: [
            { row: 0, col: 1, old: 'A', new: 'B' },
            { row: 'x', col: 0, old: 'A', new: 'B' },
            null,
          ],
        },
      }),
    );

    expect(cells).toEqual([{ row: 0, col: 1, old: 'A', new: 'B' }]);
    expect(tableCellChanges(makeChange())).toEqual([]);
  });

  it('summarises page geometry changes', () => {
    const change = makeChange({
      details: {
        pageGeometry: {
          size: { old: { width: 612, height: 792 }, new: { width: 595, height: 842 } },
          rotation: { old: 0, new: 90 },
        },
      },
    });

    expect(pageGeometrySummary(change)).toEqual([
      'Page size 612 × 792 → 595 × 842 pt',
      'Rotation 0° → 90°',
    ]);
    expect(pageGeometrySummary(makeChange())).toEqual([]);
  });

  it('suggests a portable JSON filename', () => {
    expect(suggestDiffJsonFilename('/docs/old report.pdf', 'new.pdf')).toBe(
      'old report-vs-new-diff.json',
    );
    expect(suggestDiffJsonFilename(null, null)).toBe('old-vs-new-diff.json');
  });

  it('keeps Unicode and decodes percent escapes', () => {
    expect(suggestDiffJsonFilename('测试 报告.pdf', '新 版本.pdf')).toBe(
      '测试 报告-vs-新 版本-diff.json',
    );
    expect(
      suggestDiffJsonFilename(
        'https://example.com/%E6%B5%8B%E8%AF%95%20old.pdf?token=abc',
        '/tmp/new%20file.pdf',
      ),
    ).toBe('测试 old-vs-new file-diff.json');
    expect(suggestDiffJsonFilename('_____.pdf', 'new:file?.pdf')).toBe(
      'old-vs-new_file_-diff.json',
    );
  });
});

describe('fixtures sanity', () => {
  it('summarises a sample result', () => {
    const result = makeResult([makePage({ changes: [makeChange({ kind: 'added' })] })]);

    expect(result.summary.objectsAdded).toBe(1);
    expect(result.summary.pagesChanged).toBe(1);
  });
});

describe('resolveDiffPageJump', () => {
  it('maps a typed page number to a zero-based index', () => {
    expect(resolveDiffPageJump('1', 3)).toBe(0);
    expect(resolveDiffPageJump('3', 3)).toBe(2);
    expect(resolveDiffPageJump(' 2 ', 3)).toBe(1);
  });

  it('clamps out-of-range pages instead of ignoring them', () => {
    expect(resolveDiffPageJump('0', 3)).toBe(0);
    expect(resolveDiffPageJump('99', 3)).toBe(2);
  });

  it('ignores blank, signed, fractional and non-numeric input', () => {
    expect(resolveDiffPageJump('', 3)).toBeNull();
    expect(resolveDiffPageJump('   ', 3)).toBeNull();
    expect(resolveDiffPageJump('-1', 3)).toBeNull();
    expect(resolveDiffPageJump('+2', 3)).toBeNull();
    expect(resolveDiffPageJump('2.5', 3)).toBeNull();
    expect(resolveDiffPageJump('2a', 3)).toBeNull();
    expect(resolveDiffPageJump('two', 3)).toBeNull();
    expect(resolveDiffPageJump('1e2', 3)).toBeNull();
  });

  it('returns null when the comparison has no pages', () => {
    expect(resolveDiffPageJump('1', 0)).toBeNull();
    expect(resolveDiffPageJump('1', Number.NaN)).toBeNull();
    expect(resolveDiffPageJump('1', -3)).toBeNull();
  });
});

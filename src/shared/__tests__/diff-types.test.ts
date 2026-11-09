import { describe, expect, it } from 'vitest';
import type { DiffBBox, DiffPage, DiffResult, DiffSummary } from '../diff-types';
import {
  diffOptionsToRpc,
  ignoreBBoxIntersects,
  isChangeIgnoredByRegions,
  isFileSource,
  normalizeIgnoreRegion,
} from '../diff-types';

const BOX: DiffBBox = { x0: 10, y0: 700, x1: 60, y1: 712 };

describe('diffOptionsToRpc', () => {
  it('returns an empty object when no options are given', () => {
    expect(diffOptionsToRpc()).toEqual({});
    expect(diffOptionsToRpc(null)).toEqual({});
    expect(diffOptionsToRpc({})).toEqual({});
  });

  it('maps every camelCase field to its snake_case RPC name', () => {
    expect(
      diffOptionsToRpc({
        positionTolerance: 2.5,
        textTolerance: 'case-insensitive',
        ignoreTypes: ['image', 'char'],
        ignoreFonts: true,
        ignoreColors: true,
        ignoreImages: true,
      }),
    ).toEqual({
      position_tolerance: 2.5,
      text_tolerance: 'case-insensitive',
      ignore_types: ['image', 'char'],
      ignore_fonts: true,
      ignore_colors: true,
      ignore_images: true,
    });
  });

  it('forwards only the provided fields so the engine keeps its defaults', () => {
    expect(diffOptionsToRpc({ ignoreImages: false })).toEqual({ ignore_images: false });
  });

  it('copies ignoreTypes so later mutation cannot alter a sent request', () => {
    const ignoreTypes: ('image' | 'table')[] = ['image'];
    const rpc = diffOptionsToRpc({ ignoreTypes });

    ignoreTypes.push('table');

    expect(rpc.ignore_types).toEqual(['image']);
  });

  it('maps ignore regions to the RPC snake_case fields', () => {
    expect(
      diffOptionsToRpc({
        ignoreRegions: [
          { oldPage: 1, newPage: 2, bbox: BOX },
          { oldPage: null, newPage: 3, bbox: { x0: 0, y0: 0, x1: 1, y1: 1 } },
        ],
      }),
    ).toEqual({
      ignore_regions: [
        { old_page: 1, new_page: 2, bbox: BOX },
        { old_page: null, new_page: 3, bbox: { x0: 0, y0: 0, x1: 1, y1: 1 } },
      ],
    });
  });

  it('forwards an explicitly empty region list', () => {
    expect(diffOptionsToRpc({ ignoreRegions: [] })).toEqual({ ignore_regions: [] });
  });

  it('deep-copies regions so later mutation cannot alter a sent request', () => {
    const ignoreRegions = [{ oldPage: 1, newPage: 1, bbox: { ...BOX } }];
    const rpc = diffOptionsToRpc({ ignoreRegions });

    ignoreRegions[0].oldPage = 9;
    ignoreRegions[0].bbox.x0 = -100;
    ignoreRegions.push({ oldPage: 2, newPage: 2, bbox: BOX });

    expect(rpc.ignore_regions).toEqual([{ old_page: 1, new_page: 1, bbox: BOX }]);
  });
});

describe('ignore region geometry', () => {
  it('detects overlap, including boxes that only touch an edge', () => {
    expect(ignoreBBoxIntersects(BOX, { x0: 50, y0: 700, x1: 70, y1: 720 })).toBe(true);
    expect(ignoreBBoxIntersects(BOX, { x0: 60, y0: 712, x1: 70, y1: 720 })).toBe(true);
    expect(ignoreBBoxIntersects(BOX, { x0: 0, y0: 0, x1: 10, y1: 700 })).toBe(true);
    expect(ignoreBBoxIntersects(BOX, { x0: 61, y0: 700, x1: 70, y1: 720 })).toBe(false);
    expect(ignoreBBoxIntersects(BOX, { x0: 0, y0: 0, x1: 9, y1: 699 })).toBe(false);
  });

  it('orders a reversed box and rejects non-finite coordinates', () => {
    expect(normalizeIgnoreRegion({ oldPage: 1, newPage: null, bbox: { x0: 60, y0: 712, x1: 10, y1: 700 } })).toEqual({
      oldPage: 1,
      newPage: null,
      bbox: BOX,
    });
    expect(
      normalizeIgnoreRegion({ oldPage: 1, newPage: null, bbox: { x0: 0, y0: 0, x1: Number.NaN, y1: 1 } }),
    ).toBeNull();
    expect(
      normalizeIgnoreRegion({ oldPage: 1, newPage: null, bbox: { x0: 0, y0: 0, x1: Infinity, y1: 1 } }),
    ).toBeNull();
  });

  it('rejects regions that cannot mask anything', () => {
    expect(normalizeIgnoreRegion({ oldPage: null, newPage: null, bbox: BOX })).toBeNull();
    expect(normalizeIgnoreRegion({ oldPage: 0, newPage: null, bbox: BOX })).toBeNull();
    expect(normalizeIgnoreRegion({ oldPage: 1, newPage: -1, bbox: BOX })).toBeNull();
  });

  it('matches a change by page and box on either side', () => {
    const change = {
      oldPage: 1,
      newPage: 2,
      oldBBox: BOX,
      newBBox: { x0: 300, y0: 100, x1: 360, y1: 140 },
    };

    expect(isChangeIgnoredByRegions(change, [])).toBe(false);
    expect(isChangeIgnoredByRegions(change, [{ oldPage: 1, newPage: null, bbox: BOX }])).toBe(true);
    expect(
      isChangeIgnoredByRegions(change, [
        { oldPage: null, newPage: 2, bbox: { x0: 300, y0: 100, x1: 360, y1: 140 } },
      ]),
    ).toBe(true);
    // Right box, wrong page: never masks.
    expect(isChangeIgnoredByRegions(change, [{ oldPage: 2, newPage: null, bbox: BOX }])).toBe(false);
    expect(
      isChangeIgnoredByRegions(change, [{ oldPage: 1, newPage: null, bbox: { x0: 0, y0: 0, x1: 1, y1: 1 } }]),
    ).toBe(false);
  });
});

describe('page match contract', () => {
  const paired: DiffPage = {
    oldIndex: 2,
    newIndex: 1,
    status: 'unchanged',
    oldSize: { width: 612, height: 792 },
    newSize: { width: 612, height: 792 },
    match: { score: 1, reordered: true },
    changes: [],
  };

  const oneSided: DiffPage = {
    oldIndex: null,
    newIndex: 3,
    status: 'added',
    oldSize: null,
    newSize: { width: 612, height: 792 },
    match: null,
    changes: [],
  };

  const summary: DiffSummary = {
    pagesAdded: 1,
    pagesRemoved: 0,
    pagesChanged: 0,
    pagesReordered: 1,
    objectsAdded: 0,
    objectsRemoved: 0,
    objectsMoved: 0,
    objectsModified: 0,
  };

  it('keeps schemaVersion 1 and carries the additive page match fields', () => {
    const result: DiffResult = {
      schemaVersion: 1,
      tool: { name: 'pdf-inspector', version: '0.2.0' },
      options: {
        positionTolerance: 1,
        textTolerance: 'normalized',
        ignoreTypes: [],
        ignoreFonts: false,
        ignoreColors: false,
        ignoreImages: false,
        ignoreRegions: [{ oldPage: 1, newPage: 1, bbox: BOX }],
      },
      old: { pages: 2, sha256: 'a'.repeat(64) },
      new: { pages: 2, sha256: 'b'.repeat(64) },
      summary,
      pages: [paired, oneSided],
    };

    expect(result.schemaVersion).toBe(1);
    expect(result.pages[0].match).toEqual({ score: 1, reordered: true });
    expect(result.pages[1].match).toBeNull();
    expect(result.summary.pagesReordered).toBe(1);
    // Ignore regions are echoed in the result's options for reproducibility.
    expect(result.options.ignoreRegions).toEqual([{ oldPage: 1, newPage: 1, bbox: BOX }]);
    // The additive fields survive a JSON round trip unchanged.
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it('keeps scores in 0..1 and reordered consistent with the paired indices', () => {
    expect(paired.match?.score).toBeGreaterThanOrEqual(0);
    expect(paired.match?.score).toBeLessThanOrEqual(1);
    expect(paired.match?.reordered).toBe(paired.oldIndex !== paired.newIndex);
    expect(oneSided.match).toBeNull();
  });
});

describe('isFileSource', () => {
  it('treats a string as a file path, not a File', () => {
    expect(isFileSource('/tmp/a.pdf')).toBe(false);
  });

  it('recognises a browser File', () => {
    const file = new File(['%PDF-1.7'], 'a.pdf', { type: 'application/pdf' });
    expect(isFileSource(file)).toBe(true);
  });
});

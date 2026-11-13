import { describe, expect, it } from 'vitest';
import type {
  DiffBBox,
  DiffChange,
  DiffChangeType,
  DiffDocumentChange,
  DiffPage,
  DiffResult,
  DiffSummary,
} from '../diff-types';
import {
  DIFF_OBJECT_TYPES,
  DIFF_RESOURCE_TYPES,
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
    changesTruncated: false,
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
      truncated: false,
      pages: [paired, oneSided],
    };

    expect(result.schemaVersion).toBe(1);
    expect(result.pages[0].match).toEqual({ score: 1, reordered: true });
    expect(result.pages[1].match).toBeNull();
    expect(result.summary.pagesReordered).toBe(1);
    // The change cap is additive and reported both on the summary and on the
    // result, so a consumer can trust either place.
    expect(result.truncated).toBe(false);
    expect(result.summary.changesTruncated).toBe(false);
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

describe('change cap contract', () => {
  const summaryFixture: DiffSummary = {
    pagesAdded: 0,
    pagesRemoved: 0,
    pagesChanged: 1,
    pagesReordered: 0,
    objectsAdded: 0,
    objectsRemoved: 0,
    objectsMoved: 0,
    objectsModified: 1,
    changesTruncated: false,
  };

  it('mirrors the truncation flag on the result and the summary', () => {
    // Shape of a capped run: the engine sets both flags, and the renderer reads
    // only `summary.changesTruncated`.
    const capped: Pick<DiffResult, 'truncated' | 'summary'> = {
      truncated: true,
      summary: { ...summaryFixture, changesTruncated: true },
    };

    expect(capped.truncated).toBe(true);
    expect(capped.summary.changesTruncated).toBe(true);
    expect(JSON.parse(JSON.stringify(capped))).toEqual(capped);
  });

  it('is off for a complete run', () => {
    expect(summaryFixture.changesTruncated).toBe(false);
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

describe('resource change contract', () => {
  const annotationChange: DiffChange = {
    kind: 'modified',
    type: 'annotation',
    oldPage: 1,
    newPage: 1,
    oldBBox: BOX,
    newBBox: BOX,
    textOld: 'Old note',
    textNew: 'New note',
    details: {
      resource: 'annotation',
      identity: 'ann:nm:a1',
      contents: { old: 'Old note', new: 'New note' },
    },
  };

  it('lists object types before resource types', () => {
    expect(DIFF_RESOURCE_TYPES).toEqual(['annotation', 'link', 'form', 'metadata', 'page-label']);
    // Object types keep their historical order; resources follow them.
    expect(DIFF_OBJECT_TYPES[0]).toBe('word');
    expect(DIFF_RESOURCE_TYPES).not.toContain('word');
  });

  it('accepts a page-level resource change in the page change list', () => {
    const page: DiffPage = {
      oldIndex: 1,
      newIndex: 1,
      status: 'changed',
      oldSize: { width: 612, height: 792 },
      newSize: { width: 612, height: 792 },
      match: { score: 1, reordered: false },
      changes: [annotationChange],
    };

    expect(page.changes[0].type).toBe('annotation');
    expect(page.changes[0].details.identity).toBe('ann:nm:a1');
    // A resource change is still a `DiffChange`: page grouping and the box
    // projection keep working without a separate code path.
    expect(page.changes[0].oldBBox).toEqual(BOX);
  });

  it('keeps every page-level change type inside DiffChangeType', () => {
    const types: DiffChangeType[] = [
      'word',
      'char',
      'rect',
      'line',
      'curve',
      'image',
      'table',
      'annotation',
      'link',
      'form',
    ];

    expect(types).toHaveLength(DIFF_OBJECT_TYPES.length + 3);
  });

  it('carries metadata and page labels as document changes', () => {
    const documentChanges: DiffDocumentChange[] = [
      {
        kind: 'modified',
        type: 'metadata',
        page: null,
        field: 'title',
        oldValue: 'Old title',
        newValue: 'New title',
        details: {},
      },
      {
        kind: 'modified',
        type: 'page-label',
        page: 3,
        field: 'page-label',
        oldValue: '1',
        newValue: '5',
        details: { start: { old: 1, new: 5 } },
      },
    ];
    const result: DiffResult = {
      schemaVersion: 1,
      tool: { name: 'pdf-inspector', version: '0.3.3' },
      options: {
        positionTolerance: 1,
        textTolerance: 'normalized',
        ignoreTypes: [],
        ignoreFonts: false,
        ignoreColors: false,
        ignoreImages: false,
        ignoreRegions: [],
      },
      old: { pages: 3, sha256: 'a'.repeat(64) },
      new: { pages: 3, sha256: 'b'.repeat(64) },
      summary: {
        pagesAdded: 0,
        pagesRemoved: 0,
        pagesChanged: 0,
        pagesReordered: 0,
        objectsAdded: 0,
        objectsRemoved: 0,
        objectsMoved: 0,
        objectsModified: 0,
        changesTruncated: false,
        resourcesAdded: 0,
        resourcesRemoved: 0,
        resourcesModified: 0,
        resourcesMoved: 0,
        documentChanges: 2,
      },
      truncated: false,
      documentChanges,
      pages: [],
    };

    expect(result.documentChanges).toHaveLength(2);
    expect(result.documentChanges?.[1].page).toBe(3);
    expect(result.summary.resourcesMoved).toBe(0);
    // Additive fields survive a JSON round trip unchanged.
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it('carries moved resources and collector truncation as optional counters', () => {
    const summary: DiffSummary = {
      pagesAdded: 0,
      pagesRemoved: 0,
      pagesChanged: 1,
      pagesReordered: 0,
      objectsAdded: 0,
      objectsRemoved: 0,
      objectsMoved: 0,
      objectsModified: 0,
      changesTruncated: true,
      resourcesAdded: 0,
      resourcesRemoved: 0,
      resourcesModified: 0,
      resourcesMoved: 1,
      documentChanges: 0,
      resourcesTruncated: true,
    };

    // A moved resource is counted: no "0/0/0 while listing a move".
    expect(summary.resourcesMoved).toBe(1);
    // A collector cap means the resource comparison is incomplete, and the
    // generic truncation flag is set at the same time.
    expect(summary.resourcesTruncated).toBe(true);
    expect(summary.changesTruncated).toBe(true);
    expect(JSON.parse(JSON.stringify(summary))).toEqual(summary);
  });

  it('keeps the resource counters optional for an object-only payload', () => {
    const legacy: DiffSummary = {
      pagesAdded: 0,
      pagesRemoved: 0,
      pagesChanged: 1,
      pagesReordered: 0,
      objectsAdded: 0,
      objectsRemoved: 0,
      objectsMoved: 0,
      objectsModified: 1,
      changesTruncated: false,
    };
    const result: DiffResult = {
      schemaVersion: 1,
      tool: { name: 'pdf-inspector', version: '0.3.3' },
      options: {
        positionTolerance: 1,
        textTolerance: 'normalized',
        ignoreTypes: [],
        ignoreFonts: false,
        ignoreColors: false,
        ignoreImages: false,
        ignoreRegions: [],
      },
      old: { pages: 1, sha256: 'a'.repeat(64) },
      new: { pages: 1, sha256: 'b'.repeat(64) },
      summary: legacy,
      truncated: false,
      pages: [],
    };

    expect(result.summary.resourcesAdded).toBeUndefined();
    expect(result.summary.resourcesMoved).toBeUndefined();
    expect(result.summary.resourcesTruncated).toBeUndefined();
    expect(result.documentChanges).toBeUndefined();
    // A consumer reads a missing counter as zero.
    expect(result.summary.resourcesModified ?? 0).toBe(0);
    // ... and a missing truncation flag as "complete".
    expect(result.summary.resourcesTruncated ?? false).toBe(false);
  });
});

describe('resource ignore options', () => {
  it('accepts the five resource flags as optional request options', () => {
    // Every field is optional, so an empty request stays valid.
    expect(diffOptionsToRpc({})).toEqual({});
    expect(diffOptionsToRpc({ ignoreAnnotations: false })).toEqual({
      ignore_annotations: false,
    });
  });

  it('forwards every resource flag to the snake_case RPC options', () => {
    expect(
      diffOptionsToRpc({
        ignoreAnnotations: true,
        ignoreLinks: true,
        ignoreForms: true,
        ignoreMetadata: true,
        ignorePageLabels: true,
      }),
    ).toEqual({
      ignore_annotations: true,
      ignore_links: true,
      ignore_forms: true,
      ignore_metadata: true,
      ignore_page_labels: true,
    });
  });

  it('forwards only the resource flags that were provided', () => {
    const rpc = diffOptionsToRpc({ ignoreLinks: true, ignorePageLabels: false });

    expect(rpc).toEqual({ ignore_links: true, ignore_page_labels: false });
    expect(rpc.ignore_annotations).toBeUndefined();
    expect(rpc.ignore_forms).toBeUndefined();
    expect(rpc.ignore_metadata).toBeUndefined();
  });

  it('keeps resource flags alongside the object options', () => {
    expect(
      diffOptionsToRpc({
        positionTolerance: 2,
        ignoreTypes: ['char'],
        ignoreFonts: true,
        ignoreAnnotations: true,
      }),
    ).toEqual({
      position_tolerance: 2,
      ignore_types: ['char'],
      ignore_fonts: true,
      ignore_annotations: true,
    });
  });
});

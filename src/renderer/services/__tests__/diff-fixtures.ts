/**
 * Shared fixtures for the Diff UI tests: a small result with a changed page, an
 * added page and a removed page, plus helpers to build individual changes.
 */
import type { DiffChange, DiffPage, DiffResult } from '../../../shared/diff-types';

export function makeChange(overrides: Partial<DiffChange> = {}): DiffChange {
  return {
    kind: 'modified',
    type: 'word',
    oldPage: 1,
    newPage: 1,
    oldBBox: { x0: 10, y0: 700, x1: 60, y1: 712 },
    newBBox: { x0: 10, y0: 680, x1: 60, y1: 692 },
    textOld: 'Hello',
    textNew: 'Hello world',
    details: {},
    ...overrides,
  };
}

export function makePage(overrides: Partial<DiffPage> = {}): DiffPage {
  return {
    oldIndex: 1,
    newIndex: 1,
    status: 'changed',
    oldSize: { width: 612, height: 792 },
    newSize: { width: 612, height: 792 },
    // A paired page always carries match metadata; one-sided pages must pass
    // `match: null` explicitly (see makeSampleResult).
    match: { score: 0.75, reordered: false },
    changes: [],
    ...overrides,
  };
}

export function makeResult(pages: DiffPage[]): DiffResult {
  const changes = pages.flatMap((page) => page.changes);
  const count = (kind: DiffChange['kind']): number =>
    changes.filter((change) => change.kind === kind).length;

  return {
    schemaVersion: 1,
    tool: { name: 'pdf-inspector', version: '0.2.0' },
    options: {
      positionTolerance: 1,
      textTolerance: 'normalized',
      ignoreTypes: [],
      ignoreFonts: false,
      ignoreColors: false,
      ignoreImages: false,
      ignoreRegions: [],
    },
    old: { pages: pages.filter((page) => page.oldIndex !== null).length, sha256: 'a'.repeat(64) },
    new: { pages: pages.filter((page) => page.newIndex !== null).length, sha256: 'b'.repeat(64) },
    summary: {
      pagesAdded: pages.filter((page) => page.status === 'added').length,
      pagesRemoved: pages.filter((page) => page.status === 'removed').length,
      pagesChanged: pages.filter((page) => page.status === 'changed').length,
      pagesReordered: pages.filter((page) => page.match?.reordered === true).length,
      objectsAdded: count('added'),
      objectsRemoved: count('removed'),
      objectsMoved: count('moved'),
      objectsModified: count('modified'),
    },
    pages,
  };
}

/**
 * Page 1 changed (a modified word and a removed rect), page 2 removed,
 * page 3 added.
 */
export function makeSampleResult(): DiffResult {
  return makeResult([
    makePage({
      changes: [
        makeChange(),
        makeChange({
          kind: 'removed',
          type: 'rect',
          oldPage: 1,
          newPage: null,
          oldBBox: { x0: 100, y0: 100, x1: 200, y1: 140 },
          newBBox: null,
          textOld: null,
          textNew: null,
        }),
      ],
    }),
    makePage({
      oldIndex: 2,
      newIndex: null,
      status: 'removed',
      newSize: null,
      match: null,
      changes: [
        makeChange({
          kind: 'removed',
          type: 'word',
          oldPage: 2,
          newPage: null,
          newBBox: null,
          textNew: null,
        }),
      ],
    }),
    makePage({
      oldIndex: null,
      newIndex: 2,
      status: 'added',
      oldSize: null,
      match: null,
      changes: [
        makeChange({
          kind: 'added',
          type: 'word',
          oldPage: null,
          newPage: 2,
          oldBBox: null,
          textOld: null,
        }),
      ],
    }),
  ]);
}

/** A result where nothing changed at all. */
export function makeIdenticalResult(): DiffResult {
  return makeResult([
    makePage({ status: 'unchanged' }),
    makePage({ oldIndex: 2, newIndex: 2, status: 'unchanged' }),
  ]);
}

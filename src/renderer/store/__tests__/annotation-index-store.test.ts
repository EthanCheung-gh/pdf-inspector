import { beforeEach, describe, expect, it } from 'vitest';
import {
  selectIndexAnnotations,
  selectIndexSummary,
  useAnnotationIndexStore,
} from '../annotation-index-store';
import type { AnnotationIndexResult } from '../../services/annotation-index';

const EMPTY_SUMMARY = {
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

function makeResult(scannedPages = 2): AnnotationIndexResult {
  return {
    annotations: [
      {
        id: '1:link',
        page: 1,
        subtype: 'Link',
        kind: 'link',
        rect: null,
        title: null,
        contents: null,
        modificationDate: null,
        color: null,
        opacity: null,
        hidden: false,
        link: { url: 'https://example.com/', unsafeUrl: null, internalPage: null, newWindow: false },
        form: null,
      },
    ],
    summary: { ...EMPTY_SUMMARY, annotations: 1, pagesWithAnnotations: 1, links: 1 },
    linkIssues: [],
    formIssues: [],
    formFields: [],
    scannedPages,
    truncated: false,
  };
}

const reset = (): void => {
  useAnnotationIndexStore.getState().reset();
};

describe('annotation-index-store', () => {
  beforeEach(reset);

  it('starts idle with no document, result or filters applied', () => {
    const state = useAnnotationIndexStore.getState();

    expect(state.documentKey).toBeNull();
    expect(state.status).toBe('idle');
    expect(state.progress).toBeNull();
    expect(state.result).toBeNull();
    expect(state.error).toBeNull();
    expect(state.query).toBe('');
    expect(state.kindFilter).toBe('all');
    expect(state.subtypeFilter).toBe('all');
  });

  it('starts an index run from a clean request state', () => {
    useAnnotationIndexStore.getState().start('doc-a', 4);
    useAnnotationIndexStore.getState().fail('doc-a', 'old failure');

    useAnnotationIndexStore.getState().start('doc-b', 12);

    const state = useAnnotationIndexStore.getState();
    expect(state.documentKey).toBe('doc-b');
    expect(state.status).toBe('indexing');
    expect(state.progress).toEqual({ done: 0, total: 12 });
    expect(state.result).toBeNull();
    expect(state.error).toBeNull();
  });

  it('restarts the same document with a zeroed progress bar', () => {
    useAnnotationIndexStore.getState().start('doc-a', 10);
    useAnnotationIndexStore.getState().setProgress(7, 10);

    useAnnotationIndexStore.getState().start('doc-a', 10);

    expect(useAnnotationIndexStore.getState().progress).toEqual({ done: 0, total: 10 });
    expect(useAnnotationIndexStore.getState().status).toBe('indexing');
  });

  it('records progress and clamps it into range', () => {
    useAnnotationIndexStore.getState().start('doc-a', 8);

    useAnnotationIndexStore.getState().setProgress(3, 8);
    expect(useAnnotationIndexStore.getState().progress).toEqual({ done: 3, total: 8 });

    useAnnotationIndexStore.getState().setProgress(99, 8);
    expect(useAnnotationIndexStore.getState().progress).toEqual({ done: 8, total: 8 });

    useAnnotationIndexStore.getState().setProgress(-1, 8);
    expect(useAnnotationIndexStore.getState().progress).toEqual({ done: 0, total: 8 });

    useAnnotationIndexStore.getState().setProgress(2, Number.NaN);
    expect(useAnnotationIndexStore.getState().progress).toEqual({ done: 0, total: 0 });
  });

  it('ignores progress reports that do not belong to a running index', () => {
    useAnnotationIndexStore.getState().start('doc-a', 4);
    useAnnotationIndexStore.getState().finish('doc-a', makeResult(4));

    useAnnotationIndexStore.getState().setProgress(1, 4);

    // A superseded run cannot rewind the finished progress.
    expect(useAnnotationIndexStore.getState().progress).toEqual({ done: 4, total: 4 });
    expect(useAnnotationIndexStore.getState().status).toBe('ready');
  });

  it('finishes a run and exposes the result through the selectors', () => {
    const result = makeResult(2);

    useAnnotationIndexStore.getState().start('doc-a', 2);
    expect(selectIndexAnnotations(useAnnotationIndexStore.getState())).toEqual([]);
    expect(selectIndexSummary(useAnnotationIndexStore.getState())).toBeNull();

    useAnnotationIndexStore.getState().finish('doc-a', result);

    const state = useAnnotationIndexStore.getState();
    expect(state.status).toBe('ready');
    expect(state.result).toBe(result);
    expect(state.error).toBeNull();
    expect(state.progress).toEqual({ done: 2, total: 2 });
    expect(selectIndexAnnotations(state)).toBe(result.annotations);
    expect(selectIndexSummary(state)).toBe(result.summary);
  });

  it('keeps a stable empty annotation list before an index exists', () => {
    expect(selectIndexAnnotations(useAnnotationIndexStore.getState())).toBe(
      selectIndexAnnotations(useAnnotationIndexStore.getState()),
    );
  });

  it('ignores a completion for another document', () => {
    useAnnotationIndexStore.getState().start('doc-a', 5);

    useAnnotationIndexStore.getState().finish('doc-b', makeResult());

    const state = useAnnotationIndexStore.getState();
    expect(state.status).toBe('indexing');
    expect(state.result).toBeNull();
    expect(state.documentKey).toBe('doc-a');
  });

  it('records a failure for the running document only', () => {
    useAnnotationIndexStore.getState().start('doc-a', 5);
    useAnnotationIndexStore.getState().setProgress(2, 5);

    useAnnotationIndexStore.getState().fail('doc-b', 'stale failure');
    expect(useAnnotationIndexStore.getState().status).toBe('indexing');
    expect(useAnnotationIndexStore.getState().error).toBeNull();

    useAnnotationIndexStore.getState().fail('doc-a', 'Annotation index failed on page 3: boom');

    const state = useAnnotationIndexStore.getState();
    expect(state.status).toBe('error');
    expect(state.error).toBe('Annotation index failed on page 3: boom');
    expect(state.result).toBeNull();
    expect(state.progress).toEqual({ done: 2, total: 5 });
  });

  it('drops a stale result once a new document has started', () => {
    useAnnotationIndexStore.getState().start('doc-a', 5);
    useAnnotationIndexStore.getState().start('doc-b', 5);

    useAnnotationIndexStore.getState().finish('doc-a', makeResult());

    const state = useAnnotationIndexStore.getState();
    expect(state.documentKey).toBe('doc-b');
    expect(state.status).toBe('indexing');
    expect(state.result).toBeNull();
  });

  it('tracks the query and filters without touching the result', () => {
    const result = makeResult();
    useAnnotationIndexStore.getState().start('doc-a', 2);
    useAnnotationIndexStore.getState().finish('doc-a', result);

    useAnnotationIndexStore.getState().setQuery('  Invoice  ');
    useAnnotationIndexStore.getState().setKindFilter('form');
    useAnnotationIndexStore.getState().setSubtypeFilter('Widget');

    const state = useAnnotationIndexStore.getState();
    expect(state.query).toBe('  Invoice  ');
    expect(state.kindFilter).toBe('form');
    expect(state.subtypeFilter).toBe('Widget');
    expect(state.result).toBe(result);
  });

  it('normalizes a blank subtype filter to all', () => {
    useAnnotationIndexStore.getState().setSubtypeFilter('Highlight');
    expect(useAnnotationIndexStore.getState().subtypeFilter).toBe('Highlight');

    useAnnotationIndexStore.getState().setSubtypeFilter('');
    expect(useAnnotationIndexStore.getState().subtypeFilter).toBe('all');
  });

  it('clears the query when a different document starts but keeps the filters', () => {
    useAnnotationIndexStore.getState().setQuery('chapter');
    useAnnotationIndexStore.getState().setKindFilter('link');
    useAnnotationIndexStore.getState().setSubtypeFilter('Link');

    useAnnotationIndexStore.getState().start('doc-a', 3);

    expect(useAnnotationIndexStore.getState().query).toBe('');
    expect(useAnnotationIndexStore.getState().kindFilter).toBe('link');
    expect(useAnnotationIndexStore.getState().subtypeFilter).toBe('Link');
  });

  it('resets the whole index, including the query and filters', () => {
    useAnnotationIndexStore.getState().start('doc-a', 4);
    useAnnotationIndexStore.getState().setProgress(4, 4);
    useAnnotationIndexStore.getState().finish('doc-a', makeResult(4));
    useAnnotationIndexStore.getState().setQuery('chapter');
    useAnnotationIndexStore.getState().setKindFilter('markup');
    useAnnotationIndexStore.getState().setSubtypeFilter('Highlight');

    useAnnotationIndexStore.getState().reset();

    const state = useAnnotationIndexStore.getState();
    expect(state.documentKey).toBeNull();
    expect(state.status).toBe('idle');
    expect(state.progress).toBeNull();
    expect(state.result).toBeNull();
    expect(state.error).toBeNull();
    expect(state.query).toBe('');
    expect(state.kindFilter).toBe('all');
    expect(state.subtypeFilter).toBe('all');
    expect(selectIndexAnnotations(state)).toEqual([]);
    expect(selectIndexSummary(state)).toBeNull();
  });
});

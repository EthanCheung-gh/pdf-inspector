import { beforeEach, describe, expect, it } from 'vitest';
import { useAnnotationStore } from '../annotation-store';
import type { PdfAnnotation } from '../../types/annotations';

function makeAnnotation(id: string, overrides: Partial<PdfAnnotation> = {}): PdfAnnotation {
  return {
    id,
    page: 1,
    subtype: 'Link',
    kind: 'link',
    rect: { x0: 0, y0: 0, x1: 10, y1: 10 },
    title: null,
    contents: null,
    modificationDate: null,
    color: null,
    opacity: null,
    hidden: false,
    link: null,
    form: null,
    ...overrides,
  };
}

const first = makeAnnotation('1:link-a');
const second = makeAnnotation('1:widget-b', { page: 1, subtype: 'Widget', kind: 'form' });
const pageTwo = makeAnnotation('2:link-c', { page: 2 });

const reset = (): void => {
  useAnnotationStore.getState().clear();
  useAnnotationStore.setState({ kindFilter: 'all', subtypeFilter: 'all', showBoxes: true });
};

describe('annotation-store', () => {
  beforeEach(reset);

  it('starts with empty page data and usable defaults', () => {
    const state = useAnnotationStore.getState();

    expect(state.page).toBeNull();
    expect(state.annotations).toEqual([]);
    expect(state.loading).toBe(false);
    expect(state.error).toBeNull();
    expect(state.selected).toBeNull();
    expect(state.hovered).toBeNull();
    expect(state.pendingSelectionId).toBeNull();
    expect(state.kindFilter).toBe('all');
    expect(state.subtypeFilter).toBe('all');
    expect(state.showBoxes).toBe(true);
  });

  it('stores a loaded page and finishes the request', () => {
    useAnnotationStore.getState().setLoading(true);
    useAnnotationStore.getState().setError('stale error');
    useAnnotationStore.getState().setPageData(1, [first, second]);

    const state = useAnnotationStore.getState();
    expect(state.page).toBe(1);
    expect(state.annotations).toEqual([first, second]);
    expect(state.loading).toBe(false);
    expect(state.error).toBeNull();
  });

  it('tracks loading and error independently of the page data', () => {
    useAnnotationStore.getState().setLoading(true);
    expect(useAnnotationStore.getState().loading).toBe(true);

    useAnnotationStore.getState().setError('boom');
    expect(useAnnotationStore.getState().error).toBe('boom');

    useAnnotationStore.getState().setLoading(false);
    useAnnotationStore.getState().setError(null);
    expect(useAnnotationStore.getState().loading).toBe(false);
    expect(useAnnotationStore.getState().error).toBeNull();
  });

  it('drops selection and hover when another page is loaded', () => {
    useAnnotationStore.getState().setPageData(1, [first]);
    useAnnotationStore.getState().setSelected(first);
    useAnnotationStore.getState().setHovered(first);

    useAnnotationStore.getState().setPageData(2, [pageTwo]);

    expect(useAnnotationStore.getState().selected).toBeNull();
    expect(useAnnotationStore.getState().hovered).toBeNull();
  });

  it('keeps a same-page selection and repoints it at the reloaded copy', () => {
    useAnnotationStore.getState().setPageData(1, [first]);
    useAnnotationStore.getState().setSelected(first);

    const reloaded = { ...first };
    useAnnotationStore.getState().setPageData(1, [reloaded, second]);

    expect(useAnnotationStore.getState().selected).toBe(reloaded);
  });

  it('drops a same-page selection whose annotation disappeared', () => {
    useAnnotationStore.getState().setPageData(1, [first, second]);
    useAnnotationStore.getState().setSelected(second);
    useAnnotationStore.getState().setHovered(second);

    useAnnotationStore.getState().setPageData(1, [{ ...first }]);

    expect(useAnnotationStore.getState().selected).toBeNull();
    expect(useAnnotationStore.getState().hovered).toBeNull();
  });

  it('keeps selection and hover separate', () => {
    useAnnotationStore.getState().setPageData(1, [first, second]);

    useAnnotationStore.getState().setSelected(first);
    useAnnotationStore.getState().setHovered(second);
    expect(useAnnotationStore.getState().selected).toEqual(first);
    expect(useAnnotationStore.getState().hovered).toEqual(second);

    useAnnotationStore.getState().setSelected(null);
    expect(useAnnotationStore.getState().selected).toBeNull();
    expect(useAnnotationStore.getState().hovered).toEqual(second);

    useAnnotationStore.getState().setHovered(null);
    expect(useAnnotationStore.getState().hovered).toBeNull();
  });

  it('stores the kind, subtype and box filters', () => {
    useAnnotationStore.getState().setKindFilter('form');
    useAnnotationStore.getState().setSubtypeFilter('Widget');
    useAnnotationStore.getState().setShowBoxes(false);

    expect(useAnnotationStore.getState().kindFilter).toBe('form');
    expect(useAnnotationStore.getState().subtypeFilter).toBe('Widget');
    expect(useAnnotationStore.getState().showBoxes).toBe(false);
    // Filtering is view state only: it never touches the loaded annotations.
    expect(useAnnotationStore.getState().annotations).toEqual([]);
  });

  it('normalizes a blank subtype filter to all', () => {
    useAnnotationStore.getState().setSubtypeFilter('Highlight');
    expect(useAnnotationStore.getState().subtypeFilter).toBe('Highlight');

    useAnnotationStore.getState().setSubtypeFilter('');
    expect(useAnnotationStore.getState().subtypeFilter).toBe('all');
  });

  it('bumps the reload counter without disturbing the loaded page', () => {
    useAnnotationStore.getState().setPageData(1, [first]);
    useAnnotationStore.getState().setSelected(first);
    const before = useAnnotationStore.getState().reloadKey;

    useAnnotationStore.getState().requestReload();

    const state = useAnnotationStore.getState();
    // A reload is a request for the loader; it never edits the current data.
    expect(state.reloadKey).toBe(before + 1);
    expect(state.page).toBe(1);
    expect(state.annotations).toEqual([first]);
    expect(state.selected).toEqual(first);
  });

  it('keeps the reload counter when the page data is cleared', () => {
    useAnnotationStore.getState().requestReload();
    const before = useAnnotationStore.getState().reloadKey;

    useAnnotationStore.getState().clear();

    expect(useAnnotationStore.getState().reloadKey).toBe(before);
  });

  it('clears page data, selection and request state but keeps filters and boxes', () => {
    useAnnotationStore.getState().setKindFilter('markup');
    useAnnotationStore.getState().setSubtypeFilter('Highlight');
    useAnnotationStore.getState().setShowBoxes(false);
    useAnnotationStore.getState().setLoading(true);
    useAnnotationStore.getState().setError('boom');
    useAnnotationStore.getState().setPageData(1, [first]);
    useAnnotationStore.getState().setSelected(first);
    useAnnotationStore.getState().setHovered(first);
    useAnnotationStore.getState().requestSelection('2:link-c');

    useAnnotationStore.getState().clear();

    const state = useAnnotationStore.getState();
    expect(state.page).toBeNull();
    expect(state.annotations).toEqual([]);
    expect(state.selected).toBeNull();
    expect(state.hovered).toBeNull();
    expect(state.loading).toBe(false);
    expect(state.error).toBeNull();
    // A pending request belongs to the document whose data was dropped.
    expect(state.pendingSelectionId).toBeNull();
    // User preferences survive a document/page reset.
    expect(state.kindFilter).toBe('markup');
    expect(state.subtypeFilter).toBe('Highlight');
    expect(state.showBoxes).toBe(false);
  });

  // The whole-document list points at annotations on pages that are not loaded
  // yet, so the id is remembered and applied by the page load that follows.
  it('selects the pending annotation when its page loads', () => {
    useAnnotationStore.getState().requestSelection('2:link-c');

    useAnnotationStore.getState().setPageData(2, [pageTwo]);

    const state = useAnnotationStore.getState();
    expect(state.selected).toBe(pageTwo);
    expect(state.hovered).toBeNull();
    // The request is consumed, not left armed for a later load.
    expect(state.pendingSelectionId).toBeNull();
  });

  it('drops a pending selection that the loaded page does not contain', () => {
    useAnnotationStore.getState().requestSelection('2:missing');

    useAnnotationStore.getState().setPageData(2, [pageTwo]);

    expect(useAnnotationStore.getState().selected).toBeNull();
    expect(useAnnotationStore.getState().pendingSelectionId).toBeNull();
  });

  it('prefers the pending annotation over a same-page reselect', () => {
    useAnnotationStore.getState().setPageData(1, [first]);
    useAnnotationStore.getState().setSelected(first);

    useAnnotationStore.getState().requestSelection('1:widget-b');
    useAnnotationStore.getState().setPageData(1, [first, second]);

    expect(useAnnotationStore.getState().selected).toBe(second);
    expect(useAnnotationStore.getState().pendingSelectionId).toBeNull();
  });

  it('lets an explicit selection cancel a pending request', () => {
    useAnnotationStore.getState().setPageData(1, [first, second]);
    useAnnotationStore.getState().requestSelection('2:link-c');

    useAnnotationStore.getState().setSelected(second);

    expect(useAnnotationStore.getState().pendingSelectionId).toBeNull();
    expect(useAnnotationStore.getState().selected).toBe(second);
  });

  it('allows clearing a pending request without touching the selection', () => {
    useAnnotationStore.getState().setPageData(1, [first]);
    useAnnotationStore.getState().setSelected(first);
    useAnnotationStore.getState().requestSelection('2:link-c');

    useAnnotationStore.getState().requestSelection(null);

    expect(useAnnotationStore.getState().pendingSelectionId).toBeNull();
    expect(useAnnotationStore.getState().selected).toBe(first);
  });
});

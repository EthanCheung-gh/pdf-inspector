import { beforeEach, describe, expect, it } from 'vitest';
import { useDiffStore, selectDiffPage, selectDiffSelection } from '../diff-store';
import { usePdfStore } from '../pdf-store';
import { makeChange, makeSampleResult } from '../../services/__tests__/diff-fixtures';

const store = () => useDiffStore.getState();

beforeEach(() => {
  store().reset();
});

describe('diff store sources', () => {
  it('tracks a source and its display name per side', () => {
    store().setSource('old', '/docs/old.pdf', 'old.pdf');
    store().setSource('new', '/docs/new.pdf', 'new.pdf');

    expect(store().oldSource).toBe('/docs/old.pdf');
    expect(store().oldName).toBe('old.pdf');
    expect(store().newSource).toBe('/docs/new.pdf');
    expect(store().newName).toBe('new.pdf');
  });

  it('clears the name when a side is cleared', () => {
    store().setSource('old', '/docs/old.pdf', 'old.pdf');
    store().setSource('old', null, 'old.pdf');

    expect(store().oldSource).toBeNull();
    expect(store().oldName).toBeNull();
  });

  it('accepts a picked source and ignores a cancelled pick', () => {
    store().acceptPickedSource('old', {
      canceled: false,
      source: '/docs/old.pdf',
      name: 'old.pdf',
    });
    expect(store().oldSource).toBe('/docs/old.pdf');

    store().acceptPickedSource('old', { canceled: true });
    expect(store().oldSource).toBe('/docs/old.pdf');
    expect(store().oldName).toBe('old.pdf');
  });

  it('keeps options in sync with the dialog', () => {
    store().setPositionTolerance(2.5);
    store().setOptions({ ignoreFonts: true, ignoreImages: true });

    expect(store().options.positionTolerance).toBe(2.5);
    expect(store().options.ignoreFonts).toBe(true);
    expect(store().options.ignoreImages).toBe(true);
    expect(store().options.ignoreColors).toBe(false);
  });

  it('clamps the position tolerance into a sane range', () => {
    store().setPositionTolerance(-4);
    expect(store().options.positionTolerance).toBe(0);

    store().setPositionTolerance(Number.NaN);
    expect(store().options.positionTolerance).toBe(1);

    store().setPositionTolerance(10_000);
    expect(store().options.positionTolerance).toBe(100);
  });
});

describe('diff store result lifecycle', () => {
  it('applies a result, clears loading/error and focuses the first changed page', () => {
    const result = makeSampleResult();
    store().setLoading(true);
    store().setError('previous failure');

    const applied = store().applyResult(result);

    expect(applied).toEqual({ pageIndex: 0, pages: 3, changes: 4 });
    expect(store().result).toBe(result);
    expect(store().loading).toBe(false);
    expect(store().error).toBeNull();
    expect(store().pageIndex).toBe(0);
    expect(store().selection).toBeNull();
  });

  it('starts on the first page that actually changed', () => {
    const result = makeSampleResult();
    result.pages[0].status = 'unchanged';
    result.pages[0].changes = [];

    expect(store().applyResult(result).pageIndex).toBe(1);
  });

  it('starts at page 0 when every page is identical', () => {
    const result = makeSampleResult();
    for (const page of result.pages) {
      page.status = 'unchanged';
      page.changes = [];
    }

    expect(store().applyResult(result).pageIndex).toBe(0);
  });

  it('drops a stale selection and filter when a new result arrives', () => {
    store().applyResult(makeSampleResult());
    store().selectChangeAt(0, 1);
    store().setFilter({ kind: 'removed' });

    store().applyResult(makeSampleResult());

    expect(store().selection).toBeNull();
    expect(store().filter).toEqual({ kind: 'all', type: 'all' });
  });

  it('clears the result without touching the sources', () => {
    store().setSource('old', '/docs/old.pdf', 'old.pdf');
    store().applyResult(makeSampleResult());

    store().clearResult();

    expect(store().result).toBeNull();
    expect(store().pageIndex).toBe(0);
    expect(store().selection).toBeNull();
    expect(store().oldSource).toBe('/docs/old.pdf');
  });
});

describe('diff store navigation and selection', () => {
  it('selects a change and follows it to its page', () => {
    store().applyResult(makeSampleResult());
    store().setPageIndex(2);

    store().selectChangeAt(0, 1);

    expect(store().pageIndex).toBe(0);
    expect(store().selection).toEqual({ pageIndex: 0, changeIndex: 1 });
    expect(selectDiffSelection(store())?.change.type).toBe('rect');
  });

  it('keeps the page when the selection is cleared', () => {
    store().applyResult(makeSampleResult());
    store().setPageIndex(1);
    store().selectChangeAt(0, 0);

    store().selectChange(null);

    expect(store().selection).toBeNull();
    expect(store().pageIndex).toBe(0);
  });

  it('steps between result pages and stops at the bounds', () => {
    store().applyResult(makeSampleResult());

    store().stepPage(1);
    expect(store().pageIndex).toBe(1);
    store().stepPage(5);
    expect(store().pageIndex).toBe(2);
    store().stepPage(-1);
    expect(store().pageIndex).toBe(1);
    store().stepPage(-9);
    expect(store().pageIndex).toBe(0);
  });

  it('drops a selection that belongs to another page', () => {
    store().applyResult(makeSampleResult());
    store().selectChangeAt(0, 0);

    store().setPageIndex(2);

    expect(store().selection).toBeNull();
    expect(selectDiffPage(store())?.status).toBe('added');
  });

  it('resolves the current page and handles an empty result', () => {
    expect(selectDiffPage(store())).toBeNull();

    store().applyResult(makeSampleResult());
    expect(selectDiffPage(store())?.oldIndex).toBe(1);
    expect(selectDiffSelection(store())).toBeNull();
  });
});

describe('diff store view state', () => {
  it('switches view mode and clamps zoom', () => {
    store().setViewMode('overlay');
    expect(store().viewMode).toBe('overlay');

    store().setZoom(10);
    expect(store().zoom).toBe(5);
    store().setZoom(0);
    expect(store().zoom).toBe(0.25);
    store().setZoom(Number.NaN);
    expect(store().zoom).toBe(1);
  });

  it('filters by kind and type and resets', () => {
    store().setFilter({ kind: 'removed' });
    expect(store().filter).toEqual({ kind: 'removed', type: 'all' });

    store().setFilter({ type: 'word' });
    expect(store().filter).toEqual({ kind: 'removed', type: 'word' });

    store().resetFilter();
    expect(store().filter).toEqual({ kind: 'all', type: 'all' });
  });

  it('entering and leaving the workspace keeps the result and never edits the Inspect store', () => {
    usePdfStore.setState({ filePath: '/docs/inspecting.pdf', currentPage: 4, zoom: 1.5 });
    store().applyResult(makeSampleResult());

    store().enterWorkspace();
    expect(store().active).toBe(true);
    expect(store().setupOpen).toBe(false);

    store().exitWorkspace();
    expect(store().active).toBe(false);
    expect(store().result).not.toBeNull();

    const pdf = usePdfStore.getState();
    expect(pdf.filePath).toBe('/docs/inspecting.pdf');
    expect(pdf.currentPage).toBe(4);
    expect(pdf.zoom).toBe(1.5);
  });

  it('resets every field back to its initial value', () => {
    store().setSource('old', '/docs/old.pdf', 'old.pdf');
    store().applyResult(makeSampleResult());
    store().enterWorkspace();
    store().openSetup();
    store().setViewMode('overlay');

    store().reset();

    const state = store();
    expect(state.active).toBe(false);
    expect(state.setupOpen).toBe(false);
    expect(state.oldSource).toBeNull();
    expect(state.result).toBeNull();
    expect(state.viewMode).toBe('side-by-side');
    expect(state.zoom).toBe(1);
    expect(state.filter).toEqual({ kind: 'all', type: 'all' });
    expect(state.options.ignoreTypes).toEqual([]);
  });

  it('opens and closes the setup dialog', () => {
    store().setError('boom');
    store().openSetup();
    expect(store().setupOpen).toBe(true);
    // Opening the dialog starts a fresh attempt: the previous error is gone.
    expect(store().error).toBeNull();

    store().closeSetup();
    expect(store().setupOpen).toBe(false);
  });

  it('exposes a change helper for the detail pane', () => {
    store().applyResult(makeSampleResult());
    const change = makeChange({ details: { fontSize: { old: 10, new: 12 } } });
    useDiffStore.setState({
      result: { ...store().result!, pages: [{ ...store().result!.pages[0], changes: [change] }] },
    });

    store().selectChangeAt(0, 0);
    expect(selectDiffSelection(store())?.change.details).toEqual({ fontSize: { old: 10, new: 12 } });
  });
});

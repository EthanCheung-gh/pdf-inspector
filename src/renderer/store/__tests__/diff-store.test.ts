import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_DIFF_OPTIONS,
  useDiffStore,
  selectCharacterLevelChanges,
  selectDiffDocumentChange,
  selectDiffPage,
  selectDiffSelection,
} from '../diff-store';
import { usePdfStore } from '../pdf-store';
import {
  makeChange,
  makeDocumentChange,
  makeResult,
  makeSampleResult,
  makePage,
} from '../../services/__tests__/diff-fixtures';

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

describe('diff store character-level changes', () => {
  it('ignores character-level changes by default', () => {
    // Word-level changes already report text edits; a per-glyph diff of a large
    // text PDF is the pathological case, so it is opt-in in the UI.
    expect(DEFAULT_DIFF_OPTIONS.ignoreTypes).toEqual(['char']);
    expect(store().options.ignoreTypes).toEqual(['char']);
    expect(selectCharacterLevelChanges(store())).toBe(false);
  });

  it('removes only the char entry when character-level changes are turned on', () => {
    store().setOptions({ ignoreTypes: ['char', 'image', 'table'] });

    store().setCharacterLevelChanges(true);

    expect(store().options.ignoreTypes).toEqual(['image', 'table']);
    expect(selectCharacterLevelChanges(store())).toBe(true);
    // Nothing else in the options changed.
    expect(store().options.ignoreImages).toBe(false);
    expect(store().options.positionTolerance).toBe(1);
  });

  it('adds char back when character-level changes are turned off again', () => {
    store().setOptions({ ignoreTypes: ['image'] });

    store().setCharacterLevelChanges(false);

    expect(store().options.ignoreTypes).toEqual(['image', 'char']);
    expect(selectCharacterLevelChanges(store())).toBe(false);
  });

  it('is idempotent and never duplicates the char entry', () => {
    store().setCharacterLevelChanges(false);
    store().setCharacterLevelChanges(false);
    expect(store().options.ignoreTypes).toEqual(['char']);

    store().setCharacterLevelChanges(true);
    store().setCharacterLevelChanges(true);
    expect(store().options.ignoreTypes).toEqual([]);
  });

  it('keeps the toggle working after a reset', () => {
    store().setCharacterLevelChanges(true);
    store().reset();

    expect(selectCharacterLevelChanges(store())).toBe(false);
    store().setCharacterLevelChanges(true);
    expect(store().options.ignoreTypes).toEqual([]);
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
    expect(state.options.ignoreTypes).toEqual(['char']);
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

describe('diff store ignore regions', () => {
  const REGION = { oldPage: 1, newPage: 1, bbox: { x0: 10, y0: 20, x1: 30, y1: 40 } };

  it('starts without regions and outside region mode', () => {
    expect(store().regionMode).toBe(false);
    expect(store().options.ignoreRegions).toEqual([]);
  });

  it('toggles region mode', () => {
    store().setRegionMode(true);
    expect(store().regionMode).toBe(true);

    store().setRegionMode(false);
    expect(store().regionMode).toBe(false);
  });

  it('adds, removes and clears regions through the options', () => {
    store().addIgnoreRegion(REGION);
    store().addIgnoreRegion({ oldPage: null, newPage: 2, bbox: { x0: 0, y0: 0, x1: 5, y1: 5 } });

    expect(store().options.ignoreRegions).toHaveLength(2);
    expect(store().options.ignoreRegions[0]).toEqual(REGION);

    store().removeIgnoreRegion(0);
    expect(store().options.ignoreRegions).toEqual([
      { oldPage: null, newPage: 2, bbox: { x0: 0, y0: 0, x1: 5, y1: 5 } },
    ]);

    store().clearIgnoreRegions();
    expect(store().options.ignoreRegions).toEqual([]);
  });

  it('normalizes a reversed drag box before storing it', () => {
    store().addIgnoreRegion({ oldPage: 1, newPage: 2, bbox: { x0: 30, y0: 40, x1: 10, y1: 20 } });

    expect(store().options.ignoreRegions[0].bbox).toEqual({ x0: 10, y0: 20, x1: 30, y1: 40 });
  });

  it('ignores a region that cannot mask anything', () => {
    store().addIgnoreRegion({ oldPage: null, newPage: null, bbox: REGION.bbox });
    store().addIgnoreRegion({ oldPage: 1, newPage: 1, bbox: { x0: Number.NaN, y0: 0, x1: 1, y1: 1 } });

    expect(store().options.ignoreRegions).toEqual([]);
  });

  it('removes the region at the requested index only', () => {
    store().addIgnoreRegion(REGION);
    store().addIgnoreRegion({ oldPage: 3, newPage: 3, bbox: REGION.bbox });

    store().removeIgnoreRegion(1);

    expect(store().options.ignoreRegions).toEqual([REGION]);
  });

  it('clears the regions when a source changes', () => {
    store().setSource('old', '/docs/old.pdf', 'old.pdf');
    store().setSource('new', '/docs/new.pdf', 'new.pdf');
    store().addIgnoreRegion(REGION);

    store().setSource('new', '/docs/other.pdf', 'other.pdf');

    expect(store().options.ignoreRegions).toEqual([]);
    // The rest of the options survive a source change.
    expect(store().options.positionTolerance).toBe(1);
  });

  it('accepts regions through setOptions', () => {
    store().setOptions({ ignoreRegions: [REGION] });

    expect(store().options.ignoreRegions).toEqual([REGION]);
  });

  it('resets region mode and regions with the rest of the workspace', () => {
    store().setRegionMode(true);
    store().addIgnoreRegion(REGION);

    store().reset();

    expect(store().regionMode).toBe(false);
    expect(store().options.ignoreRegions).toEqual([]);
  });
});

describe('diff store visual state', () => {
  it('defaults to a 55% blend', () => {
    expect(store().viewMode).toBe('side-by-side');
    expect(store().visualOpacity).toBe(0.55);
    expect(store().visualStyle).toBe('blend');
  });

  it('switches between all three view modes', () => {
    store().setViewMode('visual');
    expect(store().viewMode).toBe('visual');

    store().setViewMode('overlay');
    expect(store().viewMode).toBe('overlay');

    store().setViewMode('side-by-side');
    expect(store().viewMode).toBe('side-by-side');
  });

  it('clamps the visual opacity into 0..1', () => {
    store().setVisualOpacity(0.3);
    expect(store().visualOpacity).toBe(0.3);

    store().setVisualOpacity(-2);
    expect(store().visualOpacity).toBe(0);

    store().setVisualOpacity(3);
    expect(store().visualOpacity).toBe(1);

    store().setVisualOpacity(Number.NaN);
    expect(store().visualOpacity).toBe(0.55);
  });

  it('changes the visual style', () => {
    store().setVisualStyle('heatmap');
    expect(store().visualStyle).toBe('heatmap');

    store().setVisualStyle('boxes');
    expect(store().visualStyle).toBe('boxes');

    store().setVisualStyle('blend');
    expect(store().visualStyle).toBe('blend');
  });

  it('resets the visual settings with the rest of the workspace', () => {
    store().setViewMode('visual');
    store().setVisualOpacity(0.2);
    store().setVisualStyle('heatmap');

    store().reset();

    expect(store().viewMode).toBe('side-by-side');
    expect(store().visualOpacity).toBe(0.55);
    expect(store().visualStyle).toBe('blend');
  });
});

describe('diff store content resources', () => {
  it('compares every resource by default', () => {
    expect(DEFAULT_DIFF_OPTIONS).toMatchObject({
      ignoreAnnotations: false,
      ignoreLinks: false,
      ignoreForms: false,
      ignoreMetadata: false,
      ignorePageLabels: false,
    });
  });

  it('toggles one resource without touching the others', () => {
    store().setResourceIncluded('annotation', false);
    store().setResourceIncluded('page-label', false);

    expect(store().options.ignoreAnnotations).toBe(true);
    expect(store().options.ignorePageLabels).toBe(true);
    expect(store().options.ignoreLinks).toBe(false);
    expect(store().options.ignoreForms).toBe(false);
    expect(store().options.ignoreMetadata).toBe(false);

    store().setResourceIncluded('annotation', true);
    expect(store().options.ignoreAnnotations).toBe(false);
  });

  it('maps every resource type to its engine flag', () => {
    store().setResourceIncluded('link', false);
    store().setResourceIncluded('form', false);
    store().setResourceIncluded('metadata', false);

    expect(store().options.ignoreLinks).toBe(true);
    expect(store().options.ignoreForms).toBe(true);
    expect(store().options.ignoreMetadata).toBe(true);
  });

  it('restores the defaults on reset', () => {
    store().setResourceIncluded('annotation', false);
    store().setResourceIncluded('metadata', false);

    store().reset();

    expect(store().options.ignoreAnnotations).toBe(false);
    expect(store().options.ignoreMetadata).toBe(false);
  });
});

describe('diff store document selection', () => {
  const metadata = makeDocumentChange();
  const pageLabel = makeDocumentChange({
    type: 'page-label',
    page: 2,
    field: 'page-label',
    oldValue: '1',
    newValue: '5',
    details: { start: { old: 1, new: 5 } },
  });

  const applyWithDocuments = (): void => {
    store().applyResult({
      ...makeResult([
        makePage({ changes: [makeChange()] }),
        makePage({ oldIndex: 2, newIndex: 2, status: 'unchanged' }),
      ]),
      documentChanges: [metadata, pageLabel],
    });
  };

  it('selects a document change and resolves it by index', () => {
    applyWithDocuments();

    store().selectDocumentChange(1);

    expect(store().documentSelection).toBe(1);
    expect(selectDiffDocumentChange(store())).toEqual({ index: 1, change: pageLabel });
    // Nothing in the page list is selected.
    expect(store().selection).toBeNull();
    expect(selectDiffSelection(store())).toBeNull();
  });

  it('clears the document selection when a page change is selected', () => {
    applyWithDocuments();
    store().selectDocumentChange(0);
    expect(store().documentSelection).toBe(0);

    store().selectChangeAt(0, 0);

    expect(store().documentSelection).toBeNull();
    expect(store().selection).toEqual({ pageIndex: 0, changeIndex: 0 });
  });

  it('clears the page selection when a document change is selected', () => {
    applyWithDocuments();
    store().selectChangeAt(0, 0);

    store().selectDocumentChange(0);

    expect(store().selection).toBeNull();
    expect(store().documentSelection).toBe(0);
  });

  it('drops the document selection with a new or cleared result', () => {
    applyWithDocuments();
    store().selectDocumentChange(0);

    store().applyResult(makeSampleResult());
    expect(store().documentSelection).toBeNull();
    expect(selectDiffDocumentChange(store())).toBeNull();

    applyWithDocuments();
    store().selectDocumentChange(0);
    store().clearResult();
    expect(store().documentSelection).toBeNull();
  });

  it('ignores an index that no document change occupies', () => {
    applyWithDocuments();
    store().selectDocumentChange(9);

    expect(selectDiffDocumentChange(store())).toBeNull();
  });
});

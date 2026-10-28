import { beforeEach, describe, expect, it } from 'vitest';
import { usePdfStore } from '../pdf-store';
import { filterByRegion } from '../../services/object-filter';
import type { PdfChar } from '../../types/pdf-objects';

const metadata = {
  pages: 10,
  version: '1.7',
  encrypted: false,
  page_w: 612,
  page_h: 792,
  title: '',
  author: '',
  producer: '',
  fonts: [],
};

describe('pdf-store', () => {
  beforeEach(() => {
    usePdfStore.setState({
      filePath: null,
      sourceUrl: null,
      metadata: null,
      pageCount: 0,
      currentPage: 1,
      zoom: 1.0,
      pageData: null,
      allObjects: [],
      hoveredObject: null,
      selectedObject: null,
      overlayVisibility: {
        char: true, word: true, rect: true, line: true, curve: true, image: true, table: true,
      },
      isLoading: false,
      sidecarRunning: false,
      error: null,
      pdfDocRef: null,
      outline: null,
      fitWidthZoom: null,
      initialFitWidthZoom: false,
      textSelectionMode: false,
    });
  });

  it('setPdfDocRef stores the document reference', () => {
    const fakeDoc = { fake: true } as any;
    usePdfStore.getState().setPdfDocRef(fakeDoc);
    expect(usePdfStore.getState().pdfDocRef).toBe(fakeDoc);
  });

  it('setFitWidthZoom clamps to the supported range', () => {
    const { setFitWidthZoom } = usePdfStore.getState();
    setFitWidthZoom(0.1);
    expect(usePdfStore.getState().zoom).toBe(0.25);
    setFitWidthZoom(10);
    expect(usePdfStore.getState().zoom).toBe(5);
  });

  it('setFitWidthZoom sets both zoom values in range', () => {
    usePdfStore.getState().setFitWidthZoom(1.5);
    const state = usePdfStore.getState();
    expect(state.zoom).toBe(1.5);
    expect(state.fitWidthZoom).toBe(1.5);
  });

  it('setFitWidthZoom(null) resets fitWidthZoom without changing zoom', () => {
    const { setFitWidthZoom, setZoom } = usePdfStore.getState();
    setZoom(2);
    setFitWidthZoom(null);
    const state = usePdfStore.getState();
    expect(state.fitWidthZoom).toBeNull();
    expect(state.zoom).toBe(2);
  });

  it('setTextSelectionMode toggles the mode', () => {
    const { setTextSelectionMode } = usePdfStore.getState();
    setTextSelectionMode(true);
    expect(usePdfStore.getState().textSelectionMode).toBe(true);
    setTextSelectionMode(false);
    expect(usePdfStore.getState().textSelectionMode).toBe(false);
  });

  it('setPage clears page data and selection', () => {
    usePdfStore.setState({
      currentPage: 1,
      pageData: {} as any,
      allObjects: [{ type: 'char' } as any],
      hoveredObject: {} as any,
      selectedObject: {} as any,
    });
    usePdfStore.getState().setPage(5);
    const state = usePdfStore.getState();
    expect(state.currentPage).toBe(5);
    expect(state.pageData).toBeNull();
    expect(state.allObjects).toEqual([]);
    expect(state.hoveredObject).toBeNull();
    expect(state.selectedObject).toBeNull();
  });

  it('setPage does not let subsets be derived from the previous page objects', () => {
    const previousPageObjects = [char('Helvetica', 12), char('Arial', 8)];
    usePdfStore.setState({
      currentPage: 1,
      pageData: {
        width: 100, height: 100,
        chars: previousPageObjects as PdfChar[],
        words: [], rects: [], lines: [], curves: [], images: [], tables: [],
      },
      allObjects: previousPageObjects,
    });

    usePdfStore.getState().setPage(2);
    expect(usePdfStore.getState().allObjects).toEqual([]);

    // A property filter over the new (still loading) page matches nothing.
    usePdfStore.getState().setFilterCriteria({ fontname: 'Helvetica' });
    expect(usePdfStore.getState().subset?.objects).toEqual([]);

    // A region drag covering the whole page selects nothing either.
    const bbox = { x0: 0, y0: 0, x1: 1000, y1: 1000 };
    usePdfStore.getState().setSubset({
      source: 'region',
      mode: 'intersect',
      objects: filterByRegion(usePdfStore.getState().allObjects, bbox, 'intersect'),
      bbox,
    });
    expect(usePdfStore.getState().subset?.objects).toEqual([]);

    // Once the new page's data arrives, matching works again.
    usePdfStore.getState().setPageData({
      width: 100, height: 100,
      chars: [char('Helvetica', 10)],
      words: [], rects: [], lines: [], curves: [], images: [], tables: [],
    });
    expect(usePdfStore.getState().allObjects).toHaveLength(1);
    expect(filterByRegion(usePdfStore.getState().allObjects, bbox, 'intersect')).toHaveLength(1);
  });

  it('setOutline stores outline data', () => {
    const outline = [{ title: 'Chapter 1', bold: false, italic: false, dest: null, items: [] }];
    usePdfStore.getState().setOutline(outline);
    expect(usePdfStore.getState().outline).toEqual(outline);
  });

  it('setFile resets document-derived state for the new PDF', () => {
    const doc = { fake: true } as any;
    usePdfStore.setState({
      pdfDocRef: doc,
      outline: [{ title: 'Old', bold: false, italic: false, dest: null, items: [] }],
      fitWidthZoom: 1.5,
      initialFitWidthZoom: true,
    });

    usePdfStore.getState().setFile('/tmp/new.pdf', metadata);

    const state = usePdfStore.getState();
    expect(state.pdfDocRef).toBeNull();
    expect(state.outline).toBeNull();
    expect(state.fitWidthZoom).toBeNull();
    expect(state.initialFitWidthZoom).toBe(false);
  });
});

describe('search state', () => {
  it('defaults to empty search state', () => {
    const s = usePdfStore.getState();
    expect(s.searchQuery).toBe('');
    expect(s.searchMatches).toEqual([]);
    expect(s.currentMatchIndex).toBe(-1);
    expect(s.searchOpen).toBe(false);
  });

  it('setSearchQuery / setSearchMatches / setCurrentMatchIndex update fields', () => {
    const s = usePdfStore.getState();
    s.setSearchQuery('hello');
    s.setSearchMatches([{ page: 2, begin: 3, length: 5 }]);
    s.setCurrentMatchIndex(0);
    const after = usePdfStore.getState();
    expect(after.searchQuery).toBe('hello');
    expect(after.searchMatches).toEqual([{ page: 2, begin: 3, length: 5 }]);
    expect(after.currentMatchIndex).toBe(0);
  });

  it('clearSearch resets all search fields', () => {
    const s = usePdfStore.getState();
    s.setSearchQuery('x');
    s.setSearchMatches([{ page: 1, begin: 0, length: 1 }]);
    s.setCurrentMatchIndex(0);
    s.setSearchOpen(true);
    s.clearSearch();
    const after = usePdfStore.getState();
    expect(after.searchQuery).toBe('');
    expect(after.searchMatches).toEqual([]);
    expect(after.currentMatchIndex).toBe(-1);
    expect(after.searchOpen).toBe(false);
  });

  it('setFile resets search and export state', () => {
    const s = usePdfStore.getState();
    s.setSearchQuery('leftover');
    s.setSearchMatches([{ page: 1, begin: 0, length: 1 }]);
    s.setExportProgress({ done: 1, total: 5 });
    s.setFile('/tmp/a.pdf', {
      pages: 3, version: '1.7', encrypted: false, page_w: 612, page_h: 792,
      title: '', author: '', producer: '', fonts: [],
    });
    const after = usePdfStore.getState();
    expect(after.searchQuery).toBe('');
    expect(after.searchMatches).toEqual([]);
    expect(after.currentMatchIndex).toBe(-1);
    expect(after.exportProgress).toBeNull();
  });
});

describe('sourceUrl state', () => {
  beforeEach(() => {
    usePdfStore.setState({ filePath: null, sourceUrl: null, metadata: null, pageCount: 0, currentPage: 1 });
  });

  it('defaults to null', () => {
    expect(usePdfStore.getState().sourceUrl).toBeNull();
  });

  it('setFile stores the URL and resets document state', () => {
    usePdfStore.setState({
      currentPage: 4,
      pageData: {} as any,
      pdfDocRef: { fake: true } as any,
      outline: [{ title: 'Old', bold: false, italic: false, dest: null, items: [] }],
      subset: { source: 'region', mode: 'intersect', objects: [], bbox: { x0: 0, y0: 0, x1: 1, y1: 1 } },
    });

    usePdfStore.getState().setFile('/tmp/download.pdf', metadata, 'https://example.com/a.pdf');

    const state = usePdfStore.getState();
    expect(state.filePath).toBe('/tmp/download.pdf');
    expect(state.sourceUrl).toBe('https://example.com/a.pdf');
    expect(state.currentPage).toBe(1);
    expect(state.pageData).toBeNull();
    expect(state.pdfDocRef).toBeNull();
    expect(state.outline).toBeNull();
    expect(state.subset).toBeNull();
  });

  it('a following local setFile clears the URL', () => {
    usePdfStore.getState().setFile('/tmp/download.pdf', metadata, 'https://example.com/a.pdf');
    usePdfStore.getState().setFile('/tmp/local.pdf', metadata);

    const state = usePdfStore.getState();
    expect(state.filePath).toBe('/tmp/local.pdf');
    expect(state.sourceUrl).toBeNull();
  });

  it('setFile without a URL argument yields null', () => {
    usePdfStore.getState().setFile('/tmp/local.pdf', metadata);
    expect(usePdfStore.getState().sourceUrl).toBeNull();

    usePdfStore.getState().setFile('/tmp/local.pdf', metadata, null);
    expect(usePdfStore.getState().sourceUrl).toBeNull();
  });
});

describe('export progress', () => {
  it('setExportProgress sets and clears', () => {
    const s = usePdfStore.getState();
    s.setExportProgress({ done: 2, total: 10 });
    expect(usePdfStore.getState().exportProgress).toEqual({ done: 2, total: 10 });
    s.setExportProgress(null);
    expect(usePdfStore.getState().exportProgress).toBeNull();
  });
});

const char = (font: string, size: number): PdfChar => ({
  type: 'char', x0: 0, y0: 0, x1: 10, y1: 10, page: 1, text: 'A', fontname: font, size, color: '#000000',
});

describe('subset state', () => {
  beforeEach(() => {
    const store = usePdfStore.getState();
    store.setPageData({
      width: 100, height: 100,
      chars: [char('Helvetica', 12), char('Arial', 8)],
      words: [], rects: [], lines: [], curves: [], images: [], tables: [],
    });
  });

  it('setFilterCriteria recomputes the subset from allObjects', () => {
    const store = usePdfStore.getState();
    store.setFilterCriteria({ fontname: 'Helvetica' });
    const subset = usePdfStore.getState().subset;
    expect(subset?.source).toBe('filter');
    expect(subset?.objects).toHaveLength(1);
  });

  it('empty criteria clears the subset to null', () => {
    const store = usePdfStore.getState();
    store.setFilterCriteria({ fontname: 'Helvetica' });
    store.setFilterCriteria({});
    expect(usePdfStore.getState().subset).toBeNull();
  });

  it('setPage and setFile clear the subset', () => {
    const store = usePdfStore.getState();
    store.setFilterCriteria({ fontname: 'Helvetica' });
    store.setPage(2);
    expect(usePdfStore.getState().subset).toBeNull();

    store.setFilterCriteria({ fontname: 'Helvetica' });
    store.setFile('/x.pdf', { pages: 1, version: '1.7', encrypted: false, page_w: 100, page_h: 100, title: '', author: '', producer: '', fonts: [] });
    expect(usePdfStore.getState().subset).toBeNull();
  });

  it('clearSubset resets the subset to null', () => {
    const store = usePdfStore.getState();
    store.setSubset({ source: 'region', mode: 'intersect', objects: [], bbox: { x0: 0, y0: 0, x1: 1, y1: 1 } });
    expect(usePdfStore.getState().subset).not.toBeNull();
    store.clearSubset();
    expect(usePdfStore.getState().subset).toBeNull();
  });

  it('setRegionMode(false) clears the subset', () => {
    const store = usePdfStore.getState();
    store.setSubset({ source: 'region', mode: 'intersect', objects: [], bbox: { x0: 0, y0: 0, x1: 1, y1: 1 } });
    store.setRegionMode(false);
    expect(usePdfStore.getState().subset).toBeNull();
    expect(usePdfStore.getState().regionMode).toBe(false);
  });
});

describe('fontStats', () => {
  it('setFontStats stores the stats', () => {
    usePdfStore.getState().setFontStats([{ fontname: 'Helvetica', pages: [1], charCount: 9, sizeMin: 10, sizeMax: 14, colors: ['#000000'] }]);
    expect(usePdfStore.getState().fontStats).toHaveLength(1);
  });

  it('setFile resets fontStats to null', () => {
    usePdfStore.getState().setFontStats([{ fontname: 'Helvetica', pages: [1], charCount: 9, sizeMin: 10, sizeMax: 14, colors: ['#000000'] }]);
    usePdfStore.getState().setFile('/x.pdf', { pages: 1, version: '1.7', encrypted: false, page_w: 100, page_h: 100, title: '', author: '', producer: '', fonts: [] });
    expect(usePdfStore.getState().fontStats).toBeNull();
  });
});

import { beforeEach, describe, expect, it } from 'vitest';
import { usePdfStore } from '../pdf-store';

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
      hoveredObject: {} as any,
      selectedObject: {} as any,
    });
    usePdfStore.getState().setPage(5);
    const state = usePdfStore.getState();
    expect(state.currentPage).toBe(5);
    expect(state.pageData).toBeNull();
    expect(state.hoveredObject).toBeNull();
    expect(state.selectedObject).toBeNull();
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

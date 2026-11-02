// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDiffStore } from './store/diff-store';
import { usePdfStore } from './store/pdf-store';
import { useWorkspaceStore } from './store/workspace-store';
import type { PdfMetadata, PdfWord } from './types/pdf-objects';
import { makeSampleResult } from './services/__tests__/diff-fixtures';

vi.mock('./services/ipc-client', () => ({
  ipc: {
    getSidecarStatus: vi.fn(async () => ({ running: true })),
    openPdf: vi.fn(),
    openPdfUrl: vi.fn(),
    extractPage: vi.fn(),
    saveFile: vi.fn(),
    pickDiffPdf: vi.fn(),
    diffPdfs: vi.fn(),
  },
}));

// The shell test only cares about which workspace is mounted, so the heavy
// panes (and their PDF.js / CSS module graphs) are replaced by markers.
vi.mock('./components/LeftPanel/LeftPanel', () => ({
  LeftPanel: () => React.createElement('div', { 'data-testid': 'left-panel' }),
}));
vi.mock('./components/InspectorPanel/InspectorPanel', () => ({
  InspectorPanel: () => React.createElement('div', { 'data-testid': 'inspector-panel' }),
}));
vi.mock('./components/PdfViewport/PdfViewport', () => ({
  PdfViewport: () => React.createElement('div', { 'data-testid': 'pdf-viewport' }),
}));
vi.mock('./components/Workspace/PanelSplitter', () => ({ PanelSplitter: () => null }));
vi.mock('./components/Workspace/PanelRail', () => ({ PanelRail: () => null }));
vi.mock('./components/Diff/DiffWorkspace', () => ({
  DiffWorkspace: () => React.createElement('div', { 'data-testid': 'diff-workspace' }),
}));
vi.mock('./components/Diff/DiffSetupDialog', () => ({
  DiffSetupDialog: () => React.createElement('div', { 'data-testid': 'diff-setup-dialog' }),
}));

import App from './App';

const metadata: PdfMetadata = {
  pages: 5,
  version: '1.7',
  encrypted: false,
  page_w: 612,
  page_h: 792,
  title: '',
  author: '',
  producer: '',
  fonts: [],
};

beforeEach(() => {
  useDiffStore.getState().reset();
  useWorkspaceStore.setState({
    leftCollapsed: false,
    rightCollapsed: false,
    focusMode: false,
  });
  usePdfStore.setState({
    filePath: '/docs/inspecting.pdf',
    sourceUrl: null,
    metadata,
    pageCount: 5,
    currentPage: 3,
    zoom: 1.5,
    pageData: null,
    allObjects: [],
    isLoading: false,
    error: null,
  });
});

afterEach(cleanup);

describe('App workspace mode', () => {
  it('shows the Inspect panes while no diff is active', () => {
    render(React.createElement(App));

    const inspect = screen.getByTestId('inspect-area');
    expect(inspect.hidden).toBe(false);
    expect(screen.getByTestId('pdf-viewport')).toBeTruthy();
    expect(screen.getByTestId('left-panel')).toBeTruthy();
    expect(screen.getByTestId('inspector-panel')).toBeTruthy();
    expect(screen.queryByTestId('diff-workspace')).toBeNull();
    // The toolbar and status bar are part of the shell in both modes.
    expect(screen.getByRole('button', { name: 'Open' })).toBeTruthy();
    expect(screen.getByLabelText('Application status')).toBeTruthy();
  });

  it('replaces the Inspect panes with the Diff workspace and keeps the shell usable', () => {
    render(React.createElement(App));

    act(() => {
      useDiffStore.getState().applyResult(makeSampleResult());
      useDiffStore.getState().enterWorkspace();
    });

    expect(screen.getByTestId('inspect-area').hidden).toBe(true);
    expect(screen.getByTestId('diff-workspace')).toBeTruthy();
    expect(screen.getByLabelText('Application status')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open' })).toBeTruthy();
    // The Diff entry stays available and reports the active mode.
    expect(screen.getByRole('button', { name: 'Diff' }).getAttribute('aria-pressed')).toBe('true');
    // Inspect-only controls would act on the hidden document, so they are gone.
    expect(screen.queryByRole('button', { name: 'Select Text' })).toBeNull();
    expect(screen.queryByRole('group', { name: 'Page navigation' })).toBeNull();

    // The pane components stay mounted (hidden) so their local state survives.
    expect(screen.getByTestId('pdf-viewport')).toBeTruthy();
    expect(screen.getByTestId('left-panel')).toBeTruthy();
  });

  it('restores the exact Inspect state when leaving Diff', () => {
    render(React.createElement(App));
    const pageDataBefore = usePdfStore.getState().pageData;

    act(() => {
      useDiffStore.getState().applyResult(makeSampleResult());
      useDiffStore.getState().enterWorkspace();
    });
    act(() => {
      useDiffStore.getState().exitWorkspace();
    });

    expect(screen.getByTestId('inspect-area').hidden).toBe(false);
    expect(screen.queryByTestId('diff-workspace')).toBeNull();

    const pdf = usePdfStore.getState();
    expect(pdf.filePath).toBe('/docs/inspecting.pdf');
    expect(pdf.currentPage).toBe(3);
    expect(pdf.zoom).toBe(1.5);
    expect(pdf.pageData).toBe(pageDataBefore);
    // The comparison itself is kept so it can be reopened.
    expect(useDiffStore.getState().result).not.toBeNull();
    expect(useDiffStore.getState().active).toBe(false);
  });

  it('opens the diff setup dialog from the toolbar', () => {
    render(React.createElement(App));

    fireEvent.click(screen.getByRole('button', { name: 'Diff' }));
    expect(useDiffStore.getState().setupOpen).toBe(true);
  });

  it('describes the comparison in the status bar while Diff is open', () => {
    render(React.createElement(App));

    act(() => {
      useDiffStore.getState().applyResult(makeSampleResult());
      useDiffStore.getState().enterWorkspace();
    });

    const status = screen.getByLabelText('Application status');
    expect(status.textContent).toContain('Diff page 1/3');
    expect(status.textContent).toContain('4 changes');
  });

  it('leaves Inspect state alone when its shortcuts are pressed while Diff is open', () => {
    const selectedWord: PdfWord = {
      type: 'word',
      page: 2,
      x0: 10,
      y0: 20,
      x1: 30,
      y1: 32,
      text: 'Hello',
      fontname: 'Helvetica',
      size: 11,
    };
    usePdfStore.setState({
      selectedObject: selectedWord,
      filterCriteria: { types: ['word'] },
      textSelectionMode: false,
      regionMode: false,
      searchOpen: false,
    });

    render(React.createElement(App));

    // Sanity check: in Inspect mode the same shortcuts do mutate the document
    // state, so the assertions below prove the Diff guard, not a dead listener.
    fireEvent.keyDown(window, { key: 't' });
    expect(usePdfStore.getState().textSelectionMode).toBe(true);
    fireEvent.keyDown(window, { key: 't' });
    expect(usePdfStore.getState().textSelectionMode).toBe(false);

    act(() => {
      useDiffStore.getState().enterWorkspace();
    });

    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.keyDown(window, { key: 't' });
    fireEvent.keyDown(window, { key: 'r' });
    fireEvent.keyDown(window, { key: 'f' });
    fireEvent.keyDown(window, { key: 'F', ctrlKey: true });

    const pdf = usePdfStore.getState();
    expect(pdf.selectedObject).toBe(selectedWord);
    expect(pdf.filterCriteria).toEqual({ types: ['word'] });
    expect(pdf.textSelectionMode).toBe(false);
    expect(pdf.regionMode).toBe(false);
    // Ctrl+F must not open the Inspect search over the diff workspace either.
    expect(pdf.searchOpen).toBe(false);
    expect(useWorkspaceStore.getState().focusMode).toBe(false);
  });
});

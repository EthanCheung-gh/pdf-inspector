// @vitest-environment jsdom
import React from 'react';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcApi, OpenPdfResult } from '../../types/ipc-protocol';
import type { PdfMetadata } from '../../types/pdf-objects';

const { openPdfPath, openPdfUrl, activatePdfDocument, navigate } = vi.hoisted(() => ({
  openPdfPath: vi.fn(),
  openPdfUrl: vi.fn(),
  activatePdfDocument: vi.fn(),
  navigate: vi.fn(async () => {}),
}));

vi.mock('../../services/ipc-client', () => ({
  ipc: { openPdfPath, openPdfUrl, activatePdfDocument },
}));

vi.mock('../usePageNavigation', () => ({
  usePageNavigation: () => ({ navigate }),
}));

import { useSessionRestore } from '../useSessionRestore';
import { useDocumentTabsStore } from '../../store/document-tabs-store';
import { usePdfStore } from '../../store/pdf-store';
import { configureSessionStorage, createMemorySessionStorage, useSessionStore } from '../../store/session-store';
import type { SessionTabRecord } from '../../store/session-store';
import { useSessionRestoreStore } from '../../store/session-restore-store';
import { resetSessionRestoreGuard } from '../../services/session-restore';

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

const opened = (path: string): Extract<OpenPdfResult, { canceled: false }> => ({
  canceled: false,
  path,
  metadata,
});

const record = (path: string): SessionTabRecord => ({
  kind: 'local',
  path,
  sourceUrl: null,
  documentId: null,
  name: path.split('/').pop() ?? path,
  snapshot: {
    currentPage: 1,
    zoom: 1,
    overlayVisibility: {},
    leftTab: 'objects',
    inspectorTab: 'inspect',
    searchQuery: '',
  },
  lastActiveAt: 1,
});

function seedSession(paths: string[]): void {
  useSessionStore.setState({
    tabs: paths.map(record),
    activeIndex: 0,
    savedAt: Date.now(),
    restoreLastSession: true,
  });
}

const strictWrapper = ({ children }: { children: React.ReactNode }) =>
  React.createElement(React.StrictMode, null, children);

beforeEach(() => {
  configureSessionStorage(createMemorySessionStorage());
  useSessionStore.getState().reset();
  useDocumentTabsStore.getState().reset();
  usePdfStore.getState().resetDocument();
  useSessionRestoreStore.getState().reset();
  resetSessionRestoreGuard();

  openPdfPath.mockReset();
  openPdfUrl.mockReset();
  activatePdfDocument.mockReset();
  navigate.mockClear();

  openPdfPath.mockImplementation(async (path: string) => opened(path));
  (window as unknown as { pdfInspector?: Partial<IpcApi> }).pdfInspector = {
    openPdfPath,
    openPdfUrl,
    activatePdfDocument,
  };
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { pdfInspector?: Partial<IpcApi> }).pdfInspector;
  useSessionStore.getState().reset();
  useSessionRestoreStore.getState().reset();
  configureSessionStorage(null);
});

describe('useSessionRestore', () => {
  it('restores the saved session once after mount', async () => {
    seedSession(['/docs/a.pdf', '/docs/b.pdf']);

    renderHook(() => useSessionRestore(), { wrapper: strictWrapper });

    await waitFor(() =>
      expect(useDocumentTabsStore.getState().tabs.map((tab) => tab.name)).toEqual([
        'a.pdf',
        'b.pdf',
      ]),
    );
    expect(usePdfStore.getState().filePath).toBe('/docs/a.pdf');
    expect(useSessionRestoreStore.getState()).toMatchObject({
      restoring: false,
      done: 2,
      total: 2,
      failed: [],
    });
  });

  it('does not re-open documents when StrictMode runs the effect twice', async () => {
    seedSession(['/docs/a.pdf']);

    renderHook(() => useSessionRestore(), { wrapper: strictWrapper });

    await waitFor(() => expect(useDocumentTabsStore.getState().tabs).toHaveLength(1));
    // One open for the single saved tab; a second effect invocation would open
    // it twice (the module-level guard is what makes this hold).
    expect(openPdfPath).toHaveBeenCalledTimes(1);
  });

  it('does nothing when a second hook instance mounts later', async () => {
    seedSession(['/docs/a.pdf']);

    const first = renderHook(() => useSessionRestore(), { wrapper: strictWrapper });
    await waitFor(() => expect(useDocumentTabsStore.getState().tabs).toHaveLength(1));

    // A remount (or another host embedding the hook) must not restore again,
    // even though the tab bar is already populated by now.
    useDocumentTabsStore.getState().reset();
    usePdfStore.getState().resetDocument();
    openPdfPath.mockClear();

    renderHook(() => useSessionRestore(), { wrapper: strictWrapper });

    await waitFor(() => expect(useSessionRestoreStore.getState().restoring).toBe(false));
    expect(openPdfPath).not.toHaveBeenCalled();
    first.unmount();
  });

  it('renders immediately and restores in the background', async () => {
    seedSession(['/docs/a.pdf']);

    let rendered = false;
    const { rerender } = renderHook(
      () => {
        rendered = true;
        useSessionRestore();
      },
      { wrapper: strictWrapper },
    );

    // The hook does not await the restore before the component renders.
    expect(rendered).toBe(true);
    await waitFor(() => expect(useDocumentTabsStore.getState().tabs).toHaveLength(1));
    rerender();
  });

  it('does not restore when the user already has a document open', async () => {
    seedSession(['/docs/a.pdf']);
    usePdfStore.getState().setFile('/docs/current.pdf', metadata);

    renderHook(() => useSessionRestore(), { wrapper: strictWrapper });

    await waitFor(() => expect(useSessionRestoreStore.getState().restoring).toBe(false));
    expect(openPdfPath).not.toHaveBeenCalled();
    expect(usePdfStore.getState().filePath).toBe('/docs/current.pdf');
  });

  it('does not restore without a tab bridge', async () => {
    seedSession(['/docs/a.pdf']);
    delete (window as unknown as { pdfInspector?: Partial<IpcApi> }).pdfInspector;

    renderHook(() => useSessionRestore(), { wrapper: strictWrapper });

    await waitFor(() => expect(useSessionRestoreStore.getState().restoring).toBe(false));
    expect(openPdfPath).not.toHaveBeenCalled();
  });
});

// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PdfDocumentNotFoundError } from '../../../shared/document-errors';
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
vi.mock('../../hooks/usePageNavigation', () => ({
  usePageNavigation: () => ({ navigate }),
}));

import {
  RecentDocumentsDialog,
  formatRecentOpenedAt,
  groupRecentDocuments,
  recentDocumentLocation,
  recentGroupId,
} from './RecentDocumentsDialog';
import { useDocumentTabsStore } from '../../store/document-tabs-store';
import { useI18nStore } from '../../i18n/store';
import { usePdfStore } from '../../store/pdf-store';
import {
  configureSessionStorage,
  createMemorySessionStorage,
  useSessionStore,
} from '../../store/session-store';
import type { RecentDocument, SessionStorage } from '../../store/session-store';
import { useSessionUiStore } from '../../store/session-ui-store';

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

type OpenedDocument = Extract<OpenPdfResult, { canceled: false }>;

const opened = (
  path: string,
  sourceUrl?: string,
  documentId?: string,
): OpenedDocument => ({
  canceled: false,
  path,
  metadata,
  ...(sourceUrl ? { sourceUrl } : {}),
  ...(documentId ? { documentId } : {}),
});

const OPENED_AT = 1_700_000_000_000;

const localEntry: RecentDocument = {
  id: 'local-1',
  kind: 'local',
  name: 'note.pdf',
  path: '/docs/note.pdf',
  sourceUrl: null,
  documentId: null,
  openedAt: OPENED_AT,
};

const urlEntry: RecentDocument = {
  id: 'url-1',
  kind: 'url',
  name: 'https://example.com/url.pdf',
  path: 'https://example.com/url.pdf',
  sourceUrl: 'https://example.com/url.pdf',
  documentId: null,
  openedAt: OPENED_AT - 1_000,
};

const webEntry: RecentDocument = {
  id: 'web-1',
  kind: 'web',
  name: 'web.pdf',
  path: null,
  sourceUrl: 'https://example.com/web.pdf',
  documentId: 'doc-web',
  openedAt: OPENED_AT - 2_000,
};

const uploadEntry: RecentDocument = {
  id: 'upload-1',
  kind: 'upload',
  name: 'upload.pdf',
  path: '/doc/upload-1/upload.pdf',
  sourceUrl: null,
  documentId: 'doc-upload',
  openedAt: OPENED_AT - 3_000,
};

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

let storage: SessionStorage;

const seed = (recent: RecentDocument[]): void => {
  useSessionStore.setState({ recent });
  useSessionUiStore.setState({ recentDialogOpen: true });
};

const row = (id: string): HTMLElement => screen.getByTestId(`recent-row-${id}`);

beforeEach(() => {
  storage = createMemorySessionStorage();
  configureSessionStorage(storage);
  useSessionStore.getState().reset();
  useDocumentTabsStore.getState().reset();
  usePdfStore.getState().resetDocument();
  useSessionUiStore.getState().reset();
  useI18nStore.setState({ locale: 'en' });

  openPdfPath.mockReset();
  openPdfUrl.mockReset();
  activatePdfDocument.mockReset();
  navigate.mockClear();

  (window as unknown as { pdfInspector?: Partial<IpcApi> }).pdfInspector = {
    openPdfPath,
    activatePdfDocument,
  };
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { pdfInspector?: Partial<IpcApi> }).pdfInspector;
  useSessionStore.getState().reset();
  useSessionUiStore.getState().reset();
  configureSessionStorage(null);
  vi.restoreAllMocks();
});

describe('groupRecentDocuments', () => {
  it('maps kinds to the three plan groups and drops empty ones', () => {
    expect(recentGroupId('local')).toBe('local');
    expect(recentGroupId('url')).toBe('url');
    expect(recentGroupId('web')).toBe('web');
    // Uploads share the web group: both are server-side registry entries.
    expect(recentGroupId('upload')).toBe('web');

    const groups = groupRecentDocuments([localEntry, urlEntry, webEntry, uploadEntry]);
    expect(groups.map((group) => group.id)).toEqual(['local', 'url', 'web']);
    expect(groups[2].records.map((record) => record.id)).toEqual(['web-1', 'upload-1']);
    expect(groupRecentDocuments([])).toEqual([]);
    expect(groupRecentDocuments([urlEntry]).map((group) => group.id)).toEqual(['url']);
  });

  it('keeps the store order (newest first) inside a group', () => {
    const newer = { ...localEntry, id: 'local-2', openedAt: OPENED_AT + 5_000 };
    const [local] = groupRecentDocuments([newer, localEntry]);
    expect(local.records.map((record) => record.id)).toEqual(['local-2', 'local-1']);
  });

  it('labels the location of each kind without inventing a local path', () => {
    expect(recentDocumentLocation(localEntry)).toBe('/docs/note.pdf');
    expect(recentDocumentLocation(urlEntry)).toBe('https://example.com/url.pdf');
    expect(recentDocumentLocation(webEntry)).toBe('https://example.com/web.pdf');
    expect(recentDocumentLocation(uploadEntry)).toBe('/doc/upload-1/upload.pdf');
  });

  it('formats timestamps defensively', () => {
    expect(formatRecentOpenedAt(0, 'en')).toBe('');
    expect(formatRecentOpenedAt(Number.NaN, 'en')).toBe('');
    expect(formatRecentOpenedAt(OPENED_AT, 'en')).not.toBe('');
  });
});

describe('RecentDocumentsDialog', () => {
  it('shows the empty state and the privacy note with no recent entries', () => {
    seed([]);

    render(React.createElement(RecentDocumentsDialog));

    const dialog = screen.getByRole('dialog', { name: 'Recent documents' });
    expect(within(dialog).getByText('No recent documents yet')).toBeTruthy();
    expect(within(dialog).getByText(/stay on this device/i)).toBeTruthy();
    expect((within(dialog).getByRole('button', { name: 'Clear recent' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('groups rows, labels kinds and keeps full locations in titles', () => {
    seed([localEntry, urlEntry, webEntry, uploadEntry]);

    render(React.createElement(RecentDocumentsDialog));

    expect(screen.getByRole('region', { name: 'Local files' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'URL documents' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Web documents' })).toBeTruthy();

    const localRow = row('local-1');
    expect(within(localRow).getByText('note.pdf')).toBeTruthy();
    expect(within(localRow).getByText('/docs/note.pdf')).toBeTruthy();
    expect(within(localRow).getByText('Local')).toBeTruthy();
    expect(localRow.querySelector('time')?.getAttribute('datetime')).toBe(
      new Date(OPENED_AT).toISOString(),
    );

    expect(within(row('url-1')).getByText('URL')).toBeTruthy();
    expect(within(row('web-1')).getByText('Web')).toBeTruthy();
    expect(within(row('upload-1')).getByText('Upload')).toBeTruthy();
    // Upload rows never render a local path because none was ever stored.
    expect(within(row('upload-1')).queryByText('/docs/note.pdf')).toBeNull();
  });

  it('opens a local file through the path bridge and closes', async () => {
    seed([localEntry]);
    openPdfPath.mockResolvedValue(opened('/docs/note.pdf'));

    render(React.createElement(RecentDocumentsDialog));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open note.pdf' }));
    });

    expect(openPdfPath).toHaveBeenCalledWith('/docs/note.pdf');
    expect(usePdfStore.getState().filePath).toBe('/docs/note.pdf');
    // A recent entry is not a tab snapshot: it opens at the default view.
    expect(usePdfStore.getState().currentPage).toBe(1);
    expect(usePdfStore.getState().zoom).toBe(1);
    expect(navigate).toHaveBeenCalledWith(1);
    expect(useDocumentTabsStore.getState().tabs.map((tab) => tab.name)).toEqual(['note.pdf']);
    // Re-opened entries are upserted back to the top of the recent list (their
    // id is re-derived from the identity, so the store's own id is expected).
    expect(useSessionStore.getState().recent[0]).toMatchObject({
      kind: 'local',
      path: '/docs/note.pdf',
      name: 'note.pdf',
    });
    await waitFor(() => {
      expect(useSessionUiStore.getState().recentDialogOpen).toBe(false);
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens a URL document by downloading from its source URL', async () => {
    seed([urlEntry]);
    openPdfUrl.mockResolvedValue(opened('/tmp/url.pdf', urlEntry.sourceUrl ?? undefined));

    render(React.createElement(RecentDocumentsDialog));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: `Open ${urlEntry.name}` }));
    });

    expect(openPdfUrl).toHaveBeenCalledWith(urlEntry.sourceUrl);
    expect(openPdfPath).not.toHaveBeenCalled();
    expect(usePdfStore.getState().sourceUrl).toBe(urlEntry.sourceUrl);
    await waitFor(() => {
      expect(useSessionUiStore.getState().recentDialogOpen).toBe(false);
    });
  });

  it('heals a stale web document id through its source URL', async () => {
    seed([webEntry]);
    activatePdfDocument.mockRejectedValue(new PdfDocumentNotFoundError('Document not found'));
    openPdfUrl.mockResolvedValue(opened('/doc/doc-new/web.pdf', webEntry.sourceUrl ?? undefined, 'doc-new'));
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    render(React.createElement(RecentDocumentsDialog));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open web.pdf' }));
    });
    consoleWarn.mockRestore();

    expect(activatePdfDocument).toHaveBeenCalledWith('doc-web');
    expect(openPdfUrl).toHaveBeenCalledWith(webEntry.sourceUrl);
    const [tab] = useDocumentTabsStore.getState().tabs;
    expect(tab.documentId).toBe('doc-new');
    await waitFor(() => {
      expect(useSessionUiStore.getState().recentDialogOpen).toBe(false);
    });
  });

  it('keeps an upload 404 on its row instead of inventing a download', async () => {
    seed([uploadEntry, localEntry]);
    activatePdfDocument.mockRejectedValue(new PdfDocumentNotFoundError('Document not found'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(React.createElement(RecentDocumentsDialog));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open upload.pdf' }));
    });
    consoleError.mockRestore();

    expect(openPdfUrl).not.toHaveBeenCalled();
    const message = within(row('upload-1')).getByRole('alert').textContent ?? '';
    // The upload has nothing to recover from: the row says so and points at the
    // only remedy (upload again) instead of a vague "could not open".
    expect(message).toContain('no longer available');
    expect(message).toContain('Upload the file again');
    expect(message).not.toContain('Could not open');
    // The dialog stays open so the rest of the list remains usable.
    expect(useSessionUiStore.getState().recentDialogOpen).toBe(true);
    expect(usePdfStore.getState().filePath).toBeNull();
    expect(useSessionStore.getState().recent).toHaveLength(2);
  });

  it('keeps the generic failure message for non-upload entries', async () => {
    seed([localEntry]);
    openPdfPath.mockRejectedValue(new Error('ENOENT: no such file'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(React.createElement(RecentDocumentsDialog));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open note.pdf' }));
    });
    consoleError.mockRestore();

    const message = within(row('local-1')).getByRole('alert').textContent ?? '';
    expect(message).toContain('Could not open note.pdf');
    expect(message).not.toContain('no longer available');
  });

  it('removes one entry without closing the dialog', () => {
    seed([localEntry, urlEntry]);

    render(React.createElement(RecentDocumentsDialog));
    fireEvent.click(screen.getByRole('button', { name: 'Remove note.pdf from recent documents' }));

    expect(useSessionStore.getState().recent.map((record) => record.id)).toEqual(['url-1']);
    expect(screen.queryByTestId('recent-row-local-1')).toBeNull();
    expect(useSessionUiStore.getState().recentDialogOpen).toBe(true);
  });

  it('clears the list only after an explicit confirmation', () => {
    seed([localEntry, urlEntry]);

    render(React.createElement(RecentDocumentsDialog));
    fireEvent.click(screen.getByRole('button', { name: 'Clear recent' }));
    expect(screen.getByText('Remove all recent documents?')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(useSessionStore.getState().recent).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: 'Clear recent' }));
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));

    expect(useSessionStore.getState().recent).toEqual([]);
    expect(screen.getByText('No recent documents yet')).toBeTruthy();
  });

  it('toggles the automatic restore preference immediately', () => {
    seed([localEntry]);
    expect(useSessionStore.getState().restoreLastSession).toBe(true);

    render(React.createElement(RecentDocumentsDialog));
    const toggle = screen.getByRole('checkbox', { name: 'Restore last session' });
    expect((toggle as HTMLInputElement).checked).toBe(true);

    fireEvent.click(toggle);
    expect(useSessionStore.getState().restoreLastSession).toBe(false);
    expect((toggle as HTMLInputElement).checked).toBe(false);

    fireEvent.click(toggle);
    expect(useSessionStore.getState().restoreLastSession).toBe(true);
  });

  it('shows a busy state while a row is opening', async () => {
    seed([localEntry]);
    const pending = deferred<OpenPdfResult>();
    openPdfPath.mockReturnValue(pending.promise);

    render(React.createElement(RecentDocumentsDialog));
    fireEvent.click(screen.getByRole('button', { name: 'Open note.pdf' }));

    expect(screen.getByRole('status').textContent).toBe('Opening…');
    const openButton = screen.getByRole('button', { name: 'Open note.pdf' });
    expect((openButton as HTMLButtonElement).disabled).toBe(true);

    await act(async () => {
      pending.resolve(opened('/docs/note.pdf'));
      await pending.promise;
    });

    await waitFor(() => {
      expect(useSessionUiStore.getState().recentDialogOpen).toBe(false);
    });
  });

  it('closes on Escape', () => {
    seed([localEntry]);

    render(React.createElement(RecentDocumentsDialog));
    expect(screen.getByRole('dialog', { name: 'Recent documents' })).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(useSessionUiStore.getState().recentDialogOpen).toBe(false);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('returns focus to the element that opened it', () => {
    useSessionStore.setState({ recent: [localEntry] });

    const Harness = (): JSX.Element =>
      React.createElement(
        React.Fragment,
        null,
        React.createElement(
          'button',
          { type: 'button', onClick: () => useSessionUiStore.getState().openRecentDialog() },
          'opener',
        ),
        React.createElement(RecentDocumentsDialog),
      );

    render(React.createElement(Harness));
    const opener = screen.getByRole('button', { name: 'opener' });
    opener.focus();
    expect(document.activeElement).toBe(opener);

    act(() => {
      useSessionUiStore.getState().openRecentDialog();
    });
    const dialog = screen.getByRole('dialog', { name: 'Recent documents' });
    expect(document.activeElement).toBe(dialog);

    act(() => {
      useSessionUiStore.getState().closeRecentDialog();
    });
    expect(document.activeElement).toBe(opener);
  });
});

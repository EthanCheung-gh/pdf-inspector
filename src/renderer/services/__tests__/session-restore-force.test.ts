// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcApi, OpenPdfResult } from '../../types/ipc-protocol';
import type { PdfMetadata } from '../../types/pdf-objects';

const { openPdfPath, navigate } = vi.hoisted(() => ({
  openPdfPath: vi.fn(),
  navigate: vi.fn(async () => {}),
}));

vi.mock('../../services/ipc-client', () => ({
  ipc: { openPdfPath },
}));

import { resetSessionRestoreGuard, restoreSession } from '../session-restore';
import { useDocumentTabsStore } from '../../store/document-tabs-store';
import { usePdfStore } from '../../store/pdf-store';
import { useSessionRestoreStore } from '../../store/session-restore-store';
import {
  configureSessionStorage,
  createMemorySessionStorage,
  useSessionStore,
} from '../../store/session-store';
import type { SessionStorage, SessionTabRecord } from '../../store/session-store';

/**
 * `force` (manual "Restore last session") is deliberately narrow: it only skips
 * the *automatic-restore preference*. An open document and an empty saved
 * session must still refuse, because neither is about the preference.
 */

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

const opened = (path: string): OpenedDocument => ({ canceled: false, path, metadata });

const localTab = (path: string): SessionTabRecord => ({
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

let storage: SessionStorage;

beforeEach(() => {
  storage = createMemorySessionStorage();
  configureSessionStorage(storage);
  useSessionStore.getState().reset();
  useDocumentTabsStore.getState().reset();
  usePdfStore.getState().resetDocument();
  useSessionRestoreStore.getState().reset();
  resetSessionRestoreGuard();

  openPdfPath.mockReset();
  navigate.mockClear();

  (window as unknown as { pdfInspector?: Partial<IpcApi> }).pdfInspector = { openPdfPath };
});

afterEach(() => {
  delete (window as unknown as { pdfInspector?: Partial<IpcApi> }).pdfInspector;
  useSessionStore.getState().reset();
  useSessionRestoreStore.getState().reset();
  configureSessionStorage(null);
  vi.restoreAllMocks();
});

describe('restoreSession force', () => {
  it('still refuses the unattended restore when the preference is off', async () => {
    useSessionStore.setState({
      tabs: [localTab('/docs/a.pdf')],
      activeIndex: 0,
      restoreLastSession: false,
    });
    openPdfPath.mockResolvedValue(opened('/docs/a.pdf'));

    const restored = await restoreSession({ navigate });

    expect(restored).toBe(false);
    expect(openPdfPath).not.toHaveBeenCalled();
    // The saved session itself is untouched: only opening was suppressed.
    expect(useSessionStore.getState().tabs).toHaveLength(1);
  });

  it('restores the saved session when forced, despite the preference being off', async () => {
    useSessionStore.setState({
      tabs: [localTab('/docs/a.pdf')],
      activeIndex: 0,
      restoreLastSession: false,
    });
    openPdfPath.mockResolvedValue(opened('/docs/a.pdf'));

    const restored = await restoreSession({ navigate, force: true });

    expect(restored).toBe(true);
    expect(openPdfPath).toHaveBeenCalledWith('/docs/a.pdf');
    expect(useDocumentTabsStore.getState().tabs.map((tab) => tab.name)).toEqual(['a.pdf']);
    expect(usePdfStore.getState().filePath).toBe('/docs/a.pdf');
    // The preference is a setting, not a side effect: forcing a restore must not
    // silently turn automatic restore back on.
    expect(useSessionStore.getState().restoreLastSession).toBe(false);
  });

  it('does not restore over a document that is already open, even when forced', async () => {
    useSessionStore.setState({
      tabs: [localTab('/docs/a.pdf')],
      activeIndex: 0,
      restoreLastSession: true,
    });
    usePdfStore.getState().setFile('/docs/current.pdf', metadata);

    const restored = await restoreSession({ navigate, force: true });

    expect(restored).toBe(false);
    expect(openPdfPath).not.toHaveBeenCalled();
    expect(usePdfStore.getState().filePath).toBe('/docs/current.pdf');
    expect(useDocumentTabsStore.getState().tabs).toEqual([]);
  });

  it('is not blocked by the startup attempt that already ran', async () => {
    useSessionStore.setState({
      tabs: [localTab('/docs/a.pdf')],
      activeIndex: 0,
      restoreLastSession: false,
    });
    openPdfPath.mockResolvedValue(opened('/docs/a.pdf'));

    // The unattended attempt at startup runs first and refuses because the
    // preference is off. It still consumes the once-per-page-load guard, which
    // must not swallow the explicit request that follows — a user opening the
    // empty state and clicking "Restore last session" reaches the engine only
    // after that startup attempt.
    const startup = await restoreSession({ navigate });
    expect(startup).toBe(false);
    expect(openPdfPath).not.toHaveBeenCalled();

    const restored = await restoreSession({ navigate, force: true });

    expect(restored).toBe(true);
    expect(openPdfPath).toHaveBeenCalledWith('/docs/a.pdf');
    expect(useDocumentTabsStore.getState().tabs.map((tab) => tab.name)).toEqual(['a.pdf']);
  });

  it('still requires a tab bridge, even when forced', async () => {
    useSessionStore.setState({
      tabs: [localTab('/docs/a.pdf')],
      activeIndex: 0,
      restoreLastSession: false,
    });
    delete (window as unknown as { pdfInspector?: Partial<IpcApi> }).pdfInspector;

    const restored = await restoreSession({ navigate, force: true });

    expect(restored).toBe(false);
    expect(openPdfPath).not.toHaveBeenCalled();
    expect(useDocumentTabsStore.getState().tabs).toEqual([]);
  });

  it('does nothing when the saved session has no tabs, even when forced', async () => {
    useSessionStore.setState({ tabs: [], activeIndex: 0, restoreLastSession: false });

    const restored = await restoreSession({ navigate, force: true });

    expect(restored).toBe(false);
    expect(openPdfPath).not.toHaveBeenCalled();
    expect(useSessionRestoreStore.getState().restoring).toBe(false);
    expect(useSessionRestoreStore.getState().total).toBe(0);
  });
});

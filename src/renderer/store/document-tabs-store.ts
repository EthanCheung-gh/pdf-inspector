import { create } from 'zustand';
import type { PdfMetadata } from '../types/pdf-objects';
import { usePdfStore } from './pdf-store';
import type { InspectorTab, LeftPanelTab } from './workspace-store';
import { useWorkspaceStore } from './workspace-store';

/**
 * Document tabs (work packages H3/H4).
 *
 * A tab is a *lightweight view snapshot*, not a live document: the sidecar (and
 * PDF.js) only ever hold the active document, so switching re-opens the document
 * and restores page/zoom/panel state. Desktop tabs re-open a local path, web
 * tabs re-activate a server-side document id (see `activatePdfDocument` on
 * `IpcApi`). Font/audit/raw results are deliberately not snapshotted — they are
 * re-run or reset on activation, which keeps this phase free of a per-document
 * analysis cache and of N resident documents.
 */

/** The view state restored when a tab becomes active again. */
export interface DocumentViewSnapshot {
  currentPage: number;
  zoom: number;
  overlayVisibility: Record<string, boolean>;
  leftTab: LeftPanelTab;
  inspectorTab: InspectorTab;
  searchQuery: string;
}

export interface DocumentTab {
  id: string;
  /** Local path, or the downloaded temp copy for a URL-opened document. */
  path: string;
  /** Source URL the document was opened from, or null for a local file. */
  sourceUrl: string | null;
  /**
   * Id of the document in the web server's registry, or null on the desktop.
   *
   * The strongest identity a tab can have: a web activation keeps the same id
   * even though the document's `/doc/<id>` path may be re-resolved, so tabs are
   * deduped by id before URL or path.
   */
  documentId: string | null;
  /** Label shown in the tab bar (basename, or the URL). */
  name: string;
  metadata: PdfMetadata;
  snapshot: DocumentViewSnapshot;
}

/** The fields of an `OpenPdfResult` a tab needs. */
export interface DocumentTabSource {
  path: string;
  metadata: PdfMetadata;
  sourceUrl?: string | null;
  /** Registry id from a web bridge; unset on the desktop. */
  documentId?: string | null;
  /** Display name from the opening bridge, used when no URL label applies. */
  name?: string | null;
}

export interface RemoveTabResult {
  removed: DocumentTab;
  /** Tab that became active, or null when the last tab was closed. */
  nextActiveId: string | null;
}

export interface DocumentTabsState {
  tabs: DocumentTab[];
  activeTabId: string | null;
  /**
   * Add a tab for a freshly opened document, or focus the existing tab when the
   * same document id/URL/path is already open.
   *
   * The returned tab always describes the document that was just opened: a
   * matched tab is refreshed from `source` (path, metadata, document id, source
   * URL, label) and keeps only its own id and view snapshot.
   */
  addTab: (source: DocumentTabSource, name?: string) => DocumentTab;
  /** Copy the current pdf/workspace view state into the active tab. */
  saveActiveSnapshot: () => void;
  /** Mark `id` active. Opening the document is the caller's job. */
  activate: (id: string) => void;
  /** Patch a tab after a re-open (a URL tab gets a fresh temp path/metadata). */
  updateTab: (id: string, patch: Partial<Omit<DocumentTab, 'id'>>) => void;
  /**
   * Close a tab. When it was active, the neighbour at the same index (else the
   * previous one) becomes active; `nextActiveId` is null for the last tab.
   */
  removeTab: (id: string) => RemoveTabResult | null;
  reset: () => void;
}

/** Last path segment, handling both POSIX and Windows separators. */
export function documentTabName(path: string): string {
  const segments = path.split(/[\\/]/);
  return segments[segments.length - 1] || path;
}

/**
 * Whether this build can switch documents without a dialog.
 *
 * The desktop preload implements `openPdfPath`; the browser bridge implements
 * `activatePdfDocument` instead (server-side document ids). Either one is enough
 * for the tab bar, and a bridge with neither keeps it hidden.
 */
export function supportsDocumentTabs(): boolean {
  if (typeof window === 'undefined') return false;
  const bridge = window.pdfInspector;
  return (
    typeof bridge?.openPdfPath === 'function' ||
    typeof bridge?.activatePdfDocument === 'function'
  );
}

/**
 * Snapshot of the active document's view state.
 *
 * Read straight from the stores (not passed in) so a tab always captures the
 * same fields, and so the toolbar and the tab bar share one definition.
 */
export function captureViewSnapshot(): DocumentViewSnapshot {
  const pdf = usePdfStore.getState();
  const workspace = useWorkspaceStore.getState();
  return {
    currentPage: pdf.currentPage,
    zoom: pdf.zoom,
    overlayVisibility: { ...pdf.overlayVisibility },
    leftTab: workspace.leftTab,
    inspectorTab: workspace.inspectorTab,
    searchQuery: pdf.searchQuery,
  };
}

/**
 * Find a tab that already represents `source`.
 *
 * Priority follows identity strength: a server document id is the same document
 * even if its `/doc/<id>` path changed (a web activation re-resolves it), a URL
 * is the same document even though every open produces a new download copy, and
 * a local file is matched by path.
 */
export function findExistingTab(
  tabs: readonly DocumentTab[],
  source: DocumentTabSource,
): DocumentTab | undefined {
  const documentId = source.documentId ?? null;
  if (documentId) {
    // Both sides must have an id: a tab without one is a desktop document and
    // must never be confused with a web registry entry.
    const byId = tabs.find((tab) => tab.documentId !== null && tab.documentId === documentId);
    if (byId) return byId;
  }

  const sourceUrl = source.sourceUrl ?? null;
  if (sourceUrl) {
    const byUrl = tabs.find((tab) => tab.sourceUrl !== null && tab.sourceUrl === sourceUrl);
    if (byUrl) return byUrl;
  }

  return tabs.find((tab) => tab.path === source.path);
}

let tabSequence = 0;
const nextTabId = (): string => `tab-${++tabSequence}`;

/**
 * The label a tab shows for an opened document.
 *
 * A URL is its own label; otherwise prefer the name the bridge reported (keeps
 * Unicode upload names readable) before falling back to the path (a new tab) or
 * to the label the tab already had (a refreshed tab). An explicit `name` from
 * the caller always wins.
 */
function documentTabLabel(
  source: DocumentTabSource,
  name: string | undefined,
  fallback: string,
): string {
  return name ?? source.sourceUrl ?? source.name ?? fallback;
}

export const useDocumentTabsStore = create<DocumentTabsState>((set, get) => ({
  tabs: [],
  activeTabId: null,

  addTab: (source, name) => {
    const { tabs } = get();
    const existing = findExistingTab(tabs, source);
    if (existing) {
      // Opening the same document again focuses its tab instead of duplicating
      // it, and the tab adopts what the new open reported.
      //
      // That refresh is not cosmetic: a web re-open of the same URL (or a
      // re-upload of the same file) registers a *new* server document id — the
      // old one may have been LRU-evicted — and resolves a new `/doc/<id>` path.
      // Keeping the previous id would leave the tab pointing at a document the
      // server no longer has, so every following activate/close would 404. The
      // view snapshot and the tab's own id are the only things that survive.
      const refreshed: DocumentTab = {
        ...existing,
        path: source.path,
        metadata: source.metadata,
        documentId: source.documentId ?? null,
        sourceUrl: source.sourceUrl ?? null,
        name: documentTabLabel(source, name, existing.name),
      };
      set({
        tabs: tabs.map((tab) => (tab.id === existing.id ? refreshed : tab)),
        activeTabId: existing.id,
      });
      return refreshed;
    }

    const tab: DocumentTab = {
      id: nextTabId(),
      path: source.path,
      sourceUrl: source.sourceUrl ?? null,
      documentId: source.documentId ?? null,
      name: documentTabLabel(source, name, documentTabName(source.path)),
      metadata: source.metadata,
      snapshot: captureViewSnapshot(),
    };
    set({ tabs: [...tabs, tab], activeTabId: tab.id });
    return tab;
  },

  saveActiveSnapshot: () => {
    const { tabs, activeTabId } = get();
    if (!activeTabId) return;
    if (!tabs.some((tab) => tab.id === activeTabId)) return;

    const snapshot = captureViewSnapshot();
    set({
      tabs: tabs.map((tab) => (tab.id === activeTabId ? { ...tab, snapshot } : tab)),
    });
  },

  activate: (id) => {
    if (!get().tabs.some((tab) => tab.id === id)) return;
    set({ activeTabId: id });
  },

  updateTab: (id, patch) => {
    set({
      tabs: get().tabs.map((tab) => (tab.id === id ? { ...tab, ...patch, id: tab.id } : tab)),
    });
  },

  removeTab: (id) => {
    const { tabs, activeTabId } = get();
    const index = tabs.findIndex((tab) => tab.id === id);
    if (index === -1) return null;

    const removed = tabs[index];
    const remaining = tabs.filter((tab) => tab.id !== id);
    let nextActiveId = activeTabId;

    if (activeTabId === id) {
      // Prefer the tab that slides into the closed slot (the next one); when the
      // last tab was closed, fall back to the new last tab.
      const neighbour = remaining[Math.min(index, remaining.length - 1)] ?? null;
      nextActiveId = neighbour ? neighbour.id : null;
    }

    set({ tabs: remaining, activeTabId: nextActiveId });
    return { removed, nextActiveId };
  },

  reset: () => set({ tabs: [], activeTabId: null }),
}));

import { create } from 'zustand';
import type { PdfMetadata } from '../types/pdf-objects';
import { usePdfStore } from './pdf-store';
import type { InspectorTab, LeftPanelTab } from './workspace-store';
import { useWorkspaceStore } from './workspace-store';

/**
 * Desktop document tabs (work package H3).
 *
 * A tab is a *lightweight view snapshot*, not a live document: the sidecar (and
 * PDF.js) only ever hold the active document, so switching re-opens the file and
 * restores page/zoom/panel state. Font/audit/raw results are deliberately not
 * snapshotted — they are re-run or reset on activation, which keeps this phase
 * free of a per-document analysis cache and of N resident documents.
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
   * same path/URL is already open. Returns the (new or existing) tab.
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
 * Only the desktop preload implements `openPdfPath`; the browser bridge omits
 * it, which is what hides the tab bar on the web build.
 */
export function supportsDocumentTabs(): boolean {
  if (typeof window === 'undefined') return false;
  return typeof window.pdfInspector?.openPdfPath === 'function';
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
 * URL documents are matched by their source URL: re-opening the same URL gives a
 * new temp path but is the same document. Local files are matched by path.
 */
export function findExistingTab(
  tabs: readonly DocumentTab[],
  source: DocumentTabSource,
): DocumentTab | undefined {
  const sourceUrl = source.sourceUrl ?? null;
  return tabs.find((tab) =>
    sourceUrl && tab.sourceUrl ? tab.sourceUrl === sourceUrl : tab.path === source.path,
  );
}

let tabSequence = 0;
const nextTabId = (): string => `tab-${++tabSequence}`;

export const useDocumentTabsStore = create<DocumentTabsState>((set, get) => ({
  tabs: [],
  activeTabId: null,

  addTab: (source, name) => {
    const { tabs } = get();
    const existing = findExistingTab(tabs, source);
    if (existing) {
      // Opening the same document again focuses its tab instead of duplicating
      // it; the caller still re-opens the file, so the snapshot stays valid.
      set({ activeTabId: existing.id });
      return existing;
    }

    const tab: DocumentTab = {
      id: nextTabId(),
      path: source.path,
      sourceUrl: source.sourceUrl ?? null,
      // A URL is its own label; otherwise prefer the name the bridge reported
      // (keeps Unicode upload names readable) before falling back to the path.
      name: name ?? source.sourceUrl ?? source.name ?? documentTabName(source.path),
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

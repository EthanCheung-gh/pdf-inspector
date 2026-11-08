/**
 * State of the Raw workspace (object tree + content streams).
 *
 * Deliberately separate from `pdf-store`, like `diff-store` and `audit-store`:
 * - opening Raw must not touch the Inspect document, page, zoom, selection,
 *   object filters or export state, so nothing here writes to that store;
 * - raw data is a transient read-only view of the open document and is never
 *   persisted.
 *
 * Two properties drive the shape of this store:
 *
 * 1. **Requests are guarded.** The user can re-select a node, switch page, close
 *    the workspace or open another file while a request is in flight. Every
 *    request therefore carries a token per kind (`document` / `object` /
 *    `content`); a response whose token is no longer current is dropped instead
 *    of overwriting newer state.
 * 2. **Reads are cached per file.** One click must not re-ask the sidecar for an
 *    object or page it already returned, so objects are cached by
 *    `objectNumber:generation` and content by page number. The caches belong to
 *    one file: a different document clears them, while `close()` keeps them so
 *    reopening the same file is instant.
 *
 * The Raw view is read-only: nothing here can edit an object, rewrite a stream
 * or change the document.
 */
import { create } from 'zustand';
import type {
  RawDocument,
  RawObject,
  RawPageContent,
  RawRef,
  RawRoot,
} from '../types/raw-pdf';
import { ipc } from '../services/ipc-client';

/** Detail tab: the selected object or the selected page's content streams. */
export type RawTab = 'object' | 'content';

export interface RawState {
  /** True while the Raw workspace replaces the Inspect panes. */
  active: boolean;
  filePath: string | null;
  fileName: string | null;
  /** Trailer roots of the open document, or null before the first load. */
  document: RawDocument | null;
  /** The ref the user selected (highlighted in the tree), or null. */
  selected: RawRef | null;
  /** The object for `selected`, or null while it loads/on error. */
  object: RawObject | null;
  /** Decoded content streams of `contentPage`, or null. */
  content: RawPageContent | null;
  /** The 1-based page `content` belongs to (or is being loaded for). */
  contentPage: number | null;
  tab: RawTab;
  loading: boolean;
  error: string | null;

  /**
   * Enter the workspace for `filePath` and load its trailer roots.
   *
   * A different file resets every raw field (and the caches) and loads again;
   * reopening the same file reuses the loaded document and never re-asks the
   * sidecar, so leaving and returning to Raw is cheap.
   */
  open: (filePath: string, fileName: string) => void;
  /** Select a reference and load exactly that object. */
  select: (ref: RawRef) => void;
  /** Load the decoded content streams of one 1-based page (cached per file). */
  loadContent: (page: number) => void;
  /**
   * Read one page again, dropping its cached content first.
   *
   * Ordinary page switches stay cache-backed; this is the explicit "read this
   * page again" action (the panel's Reload), so it must never be answered from
   * the cache of the previous read.
   */
  reloadContent: (page: number) => void;
  setTab: (tab: RawTab) => void;
  /** Leave the workspace; in-flight requests are dropped, caches kept. */
  close: () => void;
  /** Clear every field and cache and drop any in-flight request. */
  reset: () => void;
}

type RawStateFields = Pick<
  RawState,
  | 'active'
  | 'filePath'
  | 'fileName'
  | 'document'
  | 'selected'
  | 'object'
  | 'content'
  | 'contentPage'
  | 'tab'
  | 'loading'
  | 'error'
>;

function createInitialState(): RawStateFields {
  return {
    active: false,
    filePath: null,
    fileName: null,
    document: null,
    selected: null,
    object: null,
    content: null,
    contentPage: null,
    tab: 'object',
    loading: false,
    error: null,
  };
}

/** The three independently guarded request kinds. */
type RawRequestKind = 'document' | 'object' | 'content';

/**
 * Module state on purpose: none of it is rendered, and keeping it out of the
 * store means a subscriber can never observe (or restore) a stale token or a
 * stale cached object as part of the public state.
 */
let tokens: Record<RawRequestKind, number> = { document: 0, object: 0, content: 0 };
let requestSeq = 0;
/** Requests currently in flight, so `loading` counts real work only. */
const inflight = new Map<number, RawRequestKind>();

/** The file the caches below belong to; null when nothing is cached. */
let cacheFile: string | null = null;
const objectCache = new Map<string, RawObject>();
const contentCache = new Map<number, RawPageContent>();

function refKey(ref: RawRef): string {
  return `${ref.objectNumber}:${ref.generation}`;
}

function startRequest(kind: RawRequestKind): number {
  requestSeq += 1;
  inflight.set(requestSeq, kind);
  return requestSeq;
}

function finishRequest(id: number): void {
  inflight.delete(id);
}

function isPending(): boolean {
  return inflight.size > 0;
}

/**
 * Invalidate in-flight requests of one kind and return the fresh token.
 *
 * Bumping the token drops responses that arrive later; removing that kind's
 * requests from `inflight` keeps `loading` honest when a newer request of the
 * same kind replaces an older one that will never publish its result.
 */
function invalidate(kind: RawRequestKind): number {
  tokens[kind] += 1;
  for (const [id, pendingKind] of inflight) {
    if (pendingKind === kind) inflight.delete(id);
  }
  return tokens[kind];
}

/** Invalidate every kind (close/reset/file change) and drop the loading count. */
function invalidateAll(): void {
  tokens = {
    document: tokens.document + 1,
    object: tokens.object + 1,
    content: tokens.content + 1,
  };
  inflight.clear();
}

function clearCaches(): void {
  cacheFile = null;
  objectCache.clear();
  contentCache.clear();
}

/**
 * The root the tree opens with: the first trailer root that has a reference
 * (normally the catalog), or the first root when none of them is a reference
 * (a root with an inline value is still shown, just not loaded as an object).
 */
function pickRoot(document: RawDocument): RawRoot | null {
  return document.roots.find((root) => root.ref !== null) ?? document.roots[0] ?? null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const useRawStore = create<RawState>((set, get) => {
  /**
   * Load the trailer roots and select the catalog root.
   *
   * Not awaited by `open`: the workspace only needs to become active. The
   * selection is issued before this request is removed from the loading count,
   * so the workspace does not flash "not loading" between the two calls.
   */
  const loadDocument = async (filePath: string): Promise<void> => {
    const token = invalidate('document');
    const id = startRequest('document');
    set({ loading: true, error: null });

    let document: RawDocument;
    try {
      document = await ipc.rawDocument();
    } catch (error) {
      finishRequest(id);
      // Superseded while in flight (another file, close, reset): the newer
      // request owns the error state.
      if (token !== tokens.document) {
        set({ loading: isPending() });
        return;
      }
      set({ loading: isPending(), error: errorMessage(error) });
      return;
    }

    finishRequest(id);
    if (token !== tokens.document) {
      set({ loading: isPending() });
      return;
    }
    // Guard against a late answer for a file the store already replaced.
    if (get().filePath !== filePath) {
      set({ loading: isPending() });
      return;
    }

    const root = pickRoot(document);
    set({ document, error: null });

    if (root?.ref) {
      get().select(root.ref);
    } else {
      set({ selected: null, object: null });
    }

    set({ loading: isPending() });
  };

  /**
   * The single content request path.
   *
   * `loadContent` (cache-backed) and `reloadContent` (always fresh) share it so
   * the request guards, the immediate `contentPage` publication and the error
   * handling can never drift apart.
   */
  const loadPageContent = (page: number, useCache: boolean): void => {
    const state = get();
    if (!state.filePath) return;

    const token = invalidate('content');
    const cached = useCache && cacheFile === state.filePath ? contentCache.get(page) : undefined;

    if (cached) {
      set({ content: cached, contentPage: page, loading: isPending(), error: null });
      return;
    }

    const id = startRequest('content');
    // The page is published immediately (the panel shows which page it is
    // waiting for) and the previous page's operators are cleared so they can
    // never be attributed to the page the user just picked.
    set({ content: null, contentPage: page, loading: true, error: null });

    void (async () => {
      let content: RawPageContent;
      try {
        content = await ipc.rawPageContent(page);
      } catch (error) {
        finishRequest(id);
        if (token !== tokens.content) {
          set({ loading: isPending() });
          return;
        }
        set({ loading: isPending(), error: errorMessage(error) });
        return;
      }

      finishRequest(id);
      if (token !== tokens.content) {
        set({ loading: isPending() });
        return;
      }

      contentCache.set(page, content);
      set({ content, contentPage: page, loading: isPending(), error: null });
    })();
  };

  return {
    ...createInitialState(),

    open: (filePath, fileName) => {
      const state = get();

      if (state.filePath !== filePath) {
        // A different document: drop everything derived from the old one and
        // invalidate a load that is still walking the previous file.
        invalidateAll();
        cacheFile = filePath;
        objectCache.clear();
        contentCache.clear();
        set({
          active: true,
          filePath,
          fileName,
          document: null,
          selected: null,
          object: null,
          content: null,
          contentPage: null,
          tab: 'object',
          loading: false,
          error: null,
        });
        void loadDocument(filePath);
        return;
      }

      // Same document: reuse the loaded roots (and the caches) instead of asking
      // the sidecar again; only retry when the previous attempt produced nothing.
      set({ active: true, fileName });
      if (!state.document && !state.loading) {
        void loadDocument(filePath);
      }
    },

    select: (ref) => {
      const state = get();
      if (!state.filePath) return;

      const token = invalidate('object');
      const key = refKey(ref);
      const cached = cacheFile === state.filePath ? objectCache.get(key) : undefined;

      if (cached) {
        set({ selected: ref, object: cached, loading: isPending(), error: null });
        return;
      }

      const id = startRequest('object');
      // The selection is published immediately so the tree can highlight the
      // row; `object` is cleared so the detail pane can never show the previous
      // selection's object under the new reference.
      set({ selected: ref, object: null, loading: true, error: null });

      void (async () => {
        let object: RawObject;
        try {
          object = await ipc.rawObject(ref);
        } catch (error) {
          finishRequest(id);
          if (token !== tokens.object) {
            set({ loading: isPending() });
            return;
          }
          set({ loading: isPending(), error: errorMessage(error) });
          return;
        }

        finishRequest(id);
        if (token !== tokens.object) {
          set({ loading: isPending() });
          return;
        }

        objectCache.set(key, object);
        set({ selected: ref, object, loading: isPending(), error: null });
      })();
    },

    loadContent: (page) => loadPageContent(page, true),

    reloadContent: (page) => {
      const state = get();
      if (!state.filePath) return;
      // Only this page of this file: the other cached pages, the selected
      // object and the trailer roots are untouched. Dropping the entry before
      // the request also means a failed reload cannot silently put the old
      // operators back on the next page switch.
      if (cacheFile === state.filePath) contentCache.delete(page);
      loadPageContent(page, false);
    },

    setTab: (tab) => set({ tab }),

    close: () => {
      // The loaded roots and both caches stay for a same-file reopen; the
      // requests do not, so a late answer cannot flip state behind a closed (or
      // just-reopened) workspace.
      invalidateAll();
      set({ active: false, loading: false });
    },

    reset: () => {
      invalidateAll();
      clearCaches();
      set(createInitialState());
    },
  };
});

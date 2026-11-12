import { create } from 'zustand';
import { MAX_FIT_WIDTH_ZOOM, MIN_FIT_WIDTH_ZOOM } from '../services/page-geometry';
import { documentTabName } from './document-tabs-store';
import type { DocumentTab, DocumentViewSnapshot } from './document-tabs-store';
import { INSPECTOR_TABS, LEFT_PANEL_TABS } from './workspace-store';

/**
 * Session and recent-document persistence (work package Q1).
 *
 * Two independent localStorage records:
 *
 * - `pdf-inspector:session:v1` — the tabs that were open when the app last saved
 *   (view snapshots only). `restoreLastSession` lives here because it describes
 *   what to do with *this* session, not with the recent list.
 * - `pdf-inspector:recent:v1` — the long-lived "recent documents" list, which
 *   survives closing a tab and is kept even when automatic restore is off.
 *
 * Deliberately view state only: no PDF bytes, font/audit/raw/diff results, object
 * lists, search indexes or selected objects are serialized. A tab is reduced to
 * a locator (kind + path/URL/document id) plus its `DocumentViewSnapshot`.
 *
 * Everything here is defensive. localStorage can be missing (Node/vitest),
 * throw on access (opaque origin, privacy mode) or reject writes (quota). Reads
 * and writes fall back to an in-memory mirror so the app stays usable, and
 * persisted data is sanitized field by field on load, so a hand-edited or
 * truncated record can never prevent the app from starting.
 */

/** How a session tab / recent entry was opened. */
export type SessionTabKind = 'local' | 'url' | 'web' | 'upload';

export const SESSION_TAB_KINDS: readonly SessionTabKind[] = ['local', 'url', 'web', 'upload'];

export interface SessionTabRecord {
  kind: SessionTabKind;
  /**
   * local: the local path; url: the source URL (never the temp download copy);
   * web/upload: the display path only, which is not used to re-open.
   */
  path: string | null;
  sourceUrl: string | null;
  documentId: string | null;
  name: string;
  /** View snapshot; matches `DocumentViewSnapshot` exactly. */
  snapshot: DocumentViewSnapshot;
  /** Last time this tab became active (sorting only, never written to a report). */
  lastActiveAt: number;
}

export interface RecentDocument {
  /** Dedupe key, derived from the identity. Never the raw path itself. */
  id: string;
  kind: SessionTabKind;
  name: string;
  /** local path or url; null for web/upload documents. */
  path: string | null;
  sourceUrl: string | null;
  /** Server registry id, only usable to re-open inside the same server process. */
  documentId: string | null;
  /** Last time the document was opened (sorting/display only). */
  openedAt: number;
}

export interface SessionState {
  /** Tabs of the last saved session, in tab-bar order. */
  tabs: SessionTabRecord[];
  activeIndex: number;
  /** Last save time, used for the "last session" label only. */
  savedAt: number | null;
  /** Defaults to true; turning it off keeps the recent list but skips restoring. */
  restoreLastSession: boolean;
  recent: RecentDocument[];

  /** Remember a document in the recent list (upsert, newest first). */
  recordOpen: (tab: DocumentTab) => void;
  /**
   * Closing a tab is *not* an open: it never adds or removes a recent entry, so
   * a closed document stays re-openable from the recent list. The session itself
   * is written by `saveTabs`, which the tab bar calls after every change.
   */
  recordClose: (tab: DocumentTab) => void;
  saveTabs: (tabs: DocumentTab[], activeId: string | null) => void;
  clearSession: () => void;
  setRestoreLastSession: (enabled: boolean) => void;
  removeRecent: (id: string) => void;
  clearRecent: () => void;
  reset: () => void;
}

export const SESSION_STORAGE_KEY = 'pdf-inspector:session:v1';
export const RECENT_STORAGE_KEY = 'pdf-inspector:recent:v1';

export const MAX_SESSION_TABS = 20;
export const MAX_RECENT_DOCUMENTS = 20;
/** Names, paths and URLs are bounded so one record cannot fill the quota. */
export const MAX_SESSION_STRING_LENGTH = 2048;
export const DEFAULT_RESTORE_LAST_SESSION = true;

/** Snapshot used when a persisted snapshot is missing or unusable. */
export const DEFAULT_VIEW_SNAPSHOT: DocumentViewSnapshot = {
  currentPage: 1,
  zoom: 1,
  overlayVisibility: {},
  leftTab: 'objects',
  inspectorTab: 'inspect',
  searchQuery: '',
};

/** Overlay maps are small; anything larger is a corrupted record. */
const MAX_OVERLAY_ENTRIES = 32;
const MAX_OVERLAY_KEY_LENGTH = 64;
/** The session state never needs more than a generous page bound. */
const MAX_SESSION_PAGE = 100_000;

/** The synchronous subset of the Storage API this store needs. */
export interface SessionStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const clampNumber = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const readString = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value.slice(0, MAX_SESSION_STRING_LENGTH) : fallback;

const readNullableString = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value.slice(0, MAX_SESSION_STRING_LENGTH) : null;

/** A positive finite timestamp, or null when the persisted value is unusable. */
const readTimestamp = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : null;

const readTab = <T extends string>(value: unknown, tabs: readonly T[], fallback: T): T =>
  typeof value === 'string' && (tabs as readonly string[]).includes(value)
    ? (value as T)
    : fallback;

const isSessionTabKind = (value: unknown): value is SessionTabKind =>
  typeof value === 'string' && (SESSION_TAB_KINDS as readonly string[]).includes(value);

/**
 * Overlay visibility is a `{name: boolean}` map. Only boolean entries with a
 * sane key survive: a hand-edited `{char: "yes"}` must not restore a truthy
 * non-boolean, and prototype keys are skipped instead of polluting the map.
 */
function sanitizeOverlayVisibility(value: unknown): Record<string, boolean> {
  if (!isRecord(value)) return {};

  const visibility: Record<string, boolean> = {};
  let written = 0;
  for (const [key, entry] of Object.entries(value)) {
    if (written >= MAX_OVERLAY_ENTRIES) break;
    if (typeof entry !== 'boolean') continue;
    if (!key || key.length > MAX_OVERLAY_KEY_LENGTH) continue;
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    visibility[key] = entry;
    written += 1;
  }
  return visibility;
}

/**
 * Rebuild a complete view snapshot from untrusted data.
 *
 * Page and zoom are clamped into the ranges the viewport supports, panel tabs
 * fall back to the workspace defaults, and every other field is type-checked, so
 * a restored snapshot can never produce NaN geometry or an unknown panel tab.
 */
export function sanitizeViewSnapshot(value: unknown): DocumentViewSnapshot {
  const source = isRecord(value) ? value : {};

  const page =
    typeof source.currentPage === 'number' && Number.isFinite(source.currentPage)
      ? Math.trunc(source.currentPage)
      : DEFAULT_VIEW_SNAPSHOT.currentPage;
  const zoom =
    typeof source.zoom === 'number' && Number.isFinite(source.zoom)
      ? clampNumber(source.zoom, MIN_FIT_WIDTH_ZOOM, MAX_FIT_WIDTH_ZOOM)
      : DEFAULT_VIEW_SNAPSHOT.zoom;

  return {
    currentPage: clampNumber(page, 1, MAX_SESSION_PAGE),
    zoom,
    overlayVisibility: sanitizeOverlayVisibility(source.overlayVisibility),
    leftTab: readTab(source.leftTab, LEFT_PANEL_TABS, DEFAULT_VIEW_SNAPSHOT.leftTab),
    inspectorTab: readTab(source.inspectorTab, INSPECTOR_TABS, DEFAULT_VIEW_SNAPSHOT.inspectorTab),
    searchQuery: readString(source.searchQuery),
  };
}

/**
 * How a tab was opened, derived from the locators it carries.
 *
 * The desktop has no server ids, so a tab with a source URL is a URL document;
 * on the web a registry id is always present, and an upload is the variant
 * without a source URL (nothing to re-download from).
 */
export function sessionTabKind(tab: Pick<DocumentTab, 'sourceUrl' | 'documentId'>): SessionTabKind {
  if (tab.documentId !== null) return tab.sourceUrl ? 'web' : 'upload';
  return tab.sourceUrl ? 'url' : 'local';
}

/** The `path` a session record keeps for a kind (see `SessionTabRecord.path`). */
function sessionPathForTab(kind: SessionTabKind, tab: DocumentTab): string {
  // A URL tab's `path` is its temporary download copy, which is re-created on
  // every open; the URL is what identifies it, so that is what gets persisted.
  if (kind === 'url') return tab.sourceUrl ?? tab.path;
  return tab.path;
}

interface DocumentLocator {
  kind: SessionTabKind;
  path: string | null;
  sourceUrl: string | null;
  documentId: string | null;
}

/**
 * The stable identity of a document, before it is hashed into a recent-entry id.
 *
 * Mirrors `findExistingTab`'s priority — the strongest identifier first — with
 * one deliberate exception: a web URL document is identified by its *source URL*
 * rather than its registry id, because the server re-issues the id on every
 * re-open of the same URL. An upload has no URL, so its registry id is all it
 * has.
 *
 * Returns '' when the kind's required locator is missing (a local tab without a
 * path cannot be re-opened; a web tab without an id or URL cannot be resolved).
 * Such a record is dropped instead of being restored as a broken tab.
 */
function documentIdentity(input: DocumentLocator): string {
  switch (input.kind) {
    case 'local':
      return input.path ?? '';
    case 'url':
      return input.sourceUrl ?? '';
    case 'web':
      return input.sourceUrl ?? input.documentId ?? '';
    case 'upload':
      return input.documentId ?? '';
  }
}

/** FNV-1a over the identity; small, dependency-free and stable across reloads. */
const hashIdentity = (value: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
};

/**
 * Opaque, stable recent-entry id: the kind plus a hash of the identity. The raw
 * path/URL is never used as (or embedded in) the id, so the list cannot leak a
 * local path through an identifier shown elsewhere.
 */
export function recentDocumentId(kind: SessionTabKind, identity: string): string {
  return `${kind}-${hashIdentity(identity)}-${identity.length.toString(36)}`;
}

/** Best-effort display name for a persisted record that has none. */
function resolveRecordName(value: unknown, path: string | null, sourceUrl: string | null): string {
  const name = readString(value);
  if (name) return name;
  return documentTabName(path ?? sourceUrl ?? '');
}

/** Reduce a live tab to the persisted session record (view state only). */
export function toSessionTabRecord(
  tab: DocumentTab,
  lastActiveAt: number = Date.now(),
): SessionTabRecord {
  const kind = sessionTabKind(tab);
  const name = tab.name || documentTabName(sessionPathForTab(kind, tab));
  return {
    kind,
    path: sessionPathForTab(kind, tab),
    sourceUrl: tab.sourceUrl ?? null,
    documentId: tab.documentId ?? null,
    name: readString(name),
    snapshot: sanitizeViewSnapshot(tab.snapshot),
    lastActiveAt,
  };
}

/** Reduce a live tab to a recent-list entry, or null when it has no identity. */
function recentDocumentFromTab(tab: DocumentTab, openedAt: number): RecentDocument | null {
  const kind = sessionTabKind(tab);
  const name = readString(tab.name || documentTabName(sessionPathForTab(kind, tab)));
  const path =
    kind === 'local'
      ? tab.path
      : kind === 'url'
        ? (tab.sourceUrl ?? tab.path)
        : // web/upload paths are server-side display paths, not re-open locators.
          null;
  const sourceUrl = tab.sourceUrl ?? null;
  const documentId = tab.documentId ?? null;

  const identity = documentIdentity({ kind, path, sourceUrl, documentId });
  if (!identity) return null;

  return {
    id: recentDocumentId(kind, identity),
    kind,
    name,
    path,
    sourceUrl,
    documentId,
    openedAt,
  };
}

/** Insert/replace one entry, newest first, capped at the recent-list limit. */
function nextRecentList(
  recent: readonly RecentDocument[],
  entry: RecentDocument,
): RecentDocument[] {
  const next = [entry, ...recent.filter((existing) => existing.id !== entry.id)];
  // Newest first. The sort is stable, so an entry opened in the same millisecond
  // as an older one still stays ahead of it (it was prepended above).
  next.sort((a, b) => b.openedAt - a.openedAt);
  return next.slice(0, MAX_RECENT_DOCUMENTS);
}

/** Rebuild one persisted tab record, dropping it when it cannot be restored. */
function sanitizeSessionTabRecord(value: unknown): SessionTabRecord | null {
  if (!isRecord(value)) return null;
  const rawKind = value.kind;
  if (!isSessionTabKind(rawKind)) return null;

  const path = readNullableString(value.path);
  const sourceUrl = readNullableString(value.sourceUrl);
  const documentId = readNullableString(value.documentId);
  const name = resolveRecordName(value.name, path, sourceUrl);
  if (!documentIdentity({ kind: rawKind, path, sourceUrl, documentId })) return null;

  return {
    kind: rawKind,
    path,
    sourceUrl,
    documentId,
    name,
    snapshot: sanitizeViewSnapshot(value.snapshot),
    lastActiveAt: readTimestamp(value.lastActiveAt) ?? 0,
  };
}

/** Rebuild one persisted recent entry, re-deriving its id from its identity. */
function sanitizeRecentDocument(value: unknown): RecentDocument | null {
  if (!isRecord(value)) return null;
  const rawKind = value.kind;
  if (!isSessionTabKind(rawKind)) return null;

  const path = readNullableString(value.path);
  const sourceUrl = readNullableString(value.sourceUrl);
  const documentId = readNullableString(value.documentId);
  const name = resolveRecordName(value.name, path, sourceUrl);
  const identity = documentIdentity({ kind: rawKind, path, sourceUrl, documentId });
  if (!identity) return null;

  return {
    id: recentDocumentId(rawKind, identity),
    kind: rawKind,
    name,
    path,
    sourceUrl,
    documentId,
    openedAt: readTimestamp(value.openedAt) ?? 0,
  };
}

function sanitizeSessionTabs(value: unknown): SessionTabRecord[] {
  if (!Array.isArray(value)) return [];

  const tabs: SessionTabRecord[] = [];
  for (const entry of value) {
    if (tabs.length >= MAX_SESSION_TABS) break;
    const record = sanitizeSessionTabRecord(entry);
    if (record) tabs.push(record);
  }
  return tabs;
}

function sanitizeRecentDocuments(value: unknown): RecentDocument[] {
  if (!Array.isArray(value)) return [];

  // Ids are re-derived from the identity, so hand-edited duplicates collapse
  // into one entry; the newest timestamp wins.
  const byId = new Map<string, RecentDocument>();
  for (const entry of value) {
    const record = sanitizeRecentDocument(entry);
    if (!record) continue;
    const existing = byId.get(record.id);
    if (!existing || record.openedAt > existing.openedAt) byId.set(record.id, record);
  }

  const recent = [...byId.values()];
  recent.sort((a, b) => b.openedAt - a.openedAt);
  return recent.slice(0, MAX_RECENT_DOCUMENTS);
}

/** Clamp a persisted/derived active index into the restored tab range. */
function clampActiveIndex(value: unknown, tabCount: number): number {
  if (tabCount === 0) return 0;
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return clampNumber(Math.trunc(value), 0, tabCount - 1);
}

interface PersistedSessionRecord {
  tabs: SessionTabRecord[];
  activeIndex: number;
  savedAt: number | null;
  restoreLastSession: boolean;
}

type SessionData = Pick<
  SessionState,
  'tabs' | 'activeIndex' | 'savedAt' | 'restoreLastSession' | 'recent'
>;

const defaultSessionData = (): SessionData => ({
  tabs: [],
  activeIndex: 0,
  savedAt: null,
  restoreLastSession: DEFAULT_RESTORE_LAST_SESSION,
  recent: [],
});

/** Rebuild a session record from untrusted data, field by field. */
function sanitizeSessionRecord(value: unknown): PersistedSessionRecord {
  if (!isRecord(value)) {
    return {
      tabs: [],
      activeIndex: 0,
      savedAt: null,
      restoreLastSession: DEFAULT_RESTORE_LAST_SESSION,
    };
  }

  const tabs = sanitizeSessionTabs(value.tabs);
  return {
    tabs,
    activeIndex: clampActiveIndex(value.activeIndex, tabs.length),
    savedAt: readTimestamp(value.savedAt),
    restoreLastSession:
      typeof value.restoreLastSession === 'boolean'
        ? value.restoreLastSession
        : DEFAULT_RESTORE_LAST_SESSION,
  };
}

// ---------------------------------------------------------------------------
// Storage plumbing
// ---------------------------------------------------------------------------

/** In-memory Storage-shaped backend, used for tests and as the fallback. */
export const createMemorySessionStorage = (): SessionStorage => {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
};

const memoryStorage = createMemorySessionStorage();
let storageOverride: SessionStorage | null = null;
/** Set once the real backend fails; every later read/write stays in memory. */
let preferMemory = false;

/**
 * Electron and browsers expose localStorage, but jsdom/privacy modes can leave
 * it missing or throwing on access. A missing backend simply means "memory".
 */
const nativeSessionStorage = (): SessionStorage | null => {
  try {
    if (typeof window === 'undefined') return null;
    const storage = window.localStorage;
    if (
      storage &&
      typeof storage.getItem === 'function' &&
      typeof storage.setItem === 'function' &&
      typeof storage.removeItem === 'function'
    ) {
      return storage;
    }
  } catch {
    // Access to localStorage can throw for opaque origins; use memory instead.
  }
  return null;
};

const activeStorage = (): SessionStorage | null => storageOverride ?? nativeSessionStorage();

/**
 * Replace the storage backend (tests, or an embedder). Passing null restores the
 * default resolution (`window.localStorage`, else memory). Call
 * `reloadSessionState()` afterwards to load whatever the new backend holds.
 */
export function configureSessionStorage(storage: SessionStorage | null): void {
  storageOverride = storage;
  preferMemory = false;
}

function readRaw(key: string): string | null {
  if (preferMemory) return memoryStorage.getItem(key);

  const storage = activeStorage();
  if (!storage) return memoryStorage.getItem(key);
  try {
    return storage.getItem(key);
  } catch {
    // Once the backend fails, the mirror written by this page is authoritative.
    preferMemory = true;
    return memoryStorage.getItem(key);
  }
}

/**
 * Write through to the backend, keeping a memory mirror first. A quota error or
 * a blocked storage must never reach the UI: the write degrades to memory for
 * the rest of the page instead of throwing.
 */
function writeRaw(key: string, value: string | null): void {
  if (value === null) memoryStorage.removeItem(key);
  else memoryStorage.setItem(key, value);

  if (preferMemory) return;
  const storage = activeStorage();
  if (!storage) return;
  try {
    if (value === null) storage.removeItem(key);
    else storage.setItem(key, value);
  } catch {
    preferMemory = true;
  }
}

const parseJson = (raw: string | null): unknown => {
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const readPersistedState = (): SessionData => ({
  ...sanitizeSessionRecord(parseJson(readRaw(SESSION_STORAGE_KEY))),
  recent: sanitizeRecentDocuments(parseJson(readRaw(RECENT_STORAGE_KEY))),
});

function persistSessionRecord(record: PersistedSessionRecord): void {
  writeRaw(SESSION_STORAGE_KEY, JSON.stringify(record));
}

function persistRecentDocuments(recent: readonly RecentDocument[]): void {
  writeRaw(RECENT_STORAGE_KEY, JSON.stringify(recent));
}

/**
 * Re-read both persisted records into the store. Called after
 * `configureSessionStorage` in tests; the app relies on the initial load at
 * module evaluation.
 */
export function reloadSessionState(): void {
  useSessionStore.setState(readPersistedState());
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useSessionStore = create<SessionState>((set, get) => ({
  ...readPersistedState(),

  recordOpen: (tab) => {
    const entry = recentDocumentFromTab(tab, Date.now());
    if (!entry) return;

    const recent = nextRecentList(get().recent, entry);
    set({ recent });
    persistRecentDocuments(recent);
  },

  // Closing is intentionally a no-op: a closed document stays in the recent list
  // (that is what the list is for) and the session is written by `saveTabs`.
  recordClose: (_tab: DocumentTab) => {},

  saveTabs: (tabs, activeId) => {
    const now = Date.now();
    const state = get();
    const previousActiveAt = new Map<string, number>();
    for (const record of state.tabs) {
      const identity = documentIdentity({
        kind: record.kind,
        path: record.path,
        sourceUrl: record.sourceUrl,
        documentId: record.documentId,
      });
      if (identity) previousActiveAt.set(identity, record.lastActiveAt);
    }

    // The tab bar order is the saved order; beyond the cap the tail is dropped.
    const kept = tabs.slice(0, MAX_SESSION_TABS);
    const activePosition = tabs.findIndex((tab) => tab.id === activeId);
    const records = kept.map((tab, index) => {
      const kind = sessionTabKind(tab);
      const identity = documentIdentity({
        kind,
        path: sessionPathForTab(kind, tab),
        sourceUrl: tab.sourceUrl ?? null,
        documentId: tab.documentId ?? null,
      });
      // An unchanged tab keeps the moment it was last activated; the tab being
      // activated now — and any never-seen tab — gets a fresh, ordered value.
      const lastActiveAt =
        index === activePosition
          ? now
          : (previousActiveAt.get(identity) ?? now - (kept.length - index));
      return toSessionTabRecord(tab, lastActiveAt);
    });

    const activeIndex =
      activePosition < 0 || records.length === 0
        ? 0
        : Math.min(activePosition, records.length - 1);

    set({ tabs: records, activeIndex, savedAt: now });
    persistSessionRecord({
      tabs: records,
      activeIndex,
      savedAt: now,
      restoreLastSession: state.restoreLastSession,
    });
  },

  // An emptied session is still written: the next start must not restore tabs
  // the user closed. The restore preference is kept (it is a user setting).
  clearSession: () => {
    const { restoreLastSession } = get();
    set({ tabs: [], activeIndex: 0, savedAt: null });
    persistSessionRecord({
      tabs: [],
      activeIndex: 0,
      savedAt: null,
      restoreLastSession,
    });
  },

  setRestoreLastSession: (enabled) => {
    set({ restoreLastSession: enabled });
    const { tabs, activeIndex, savedAt } = get();
    persistSessionRecord({ tabs, activeIndex, savedAt, restoreLastSession: enabled });
  },

  removeRecent: (id) => {
    const recent = get().recent.filter((entry) => entry.id !== id);
    set({ recent });
    persistRecentDocuments(recent);
  },

  clearRecent: () => {
    set({ recent: [] });
    persistRecentDocuments([]);
  },

  // Back to first-run defaults, including forgotten persistence.
  reset: () => {
    set(defaultSessionData());
    writeRaw(SESSION_STORAGE_KEY, null);
    writeRaw(RECENT_STORAGE_KEY, null);
  },
}));

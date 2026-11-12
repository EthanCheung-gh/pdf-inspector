import { PdfDocumentNotFoundError } from '../../shared/document-errors';
import { clampSnapshotPage, restoreViewSnapshot } from '../components/Workspace/DocumentTabs';
import { supportsDocumentTabs, useDocumentTabsStore } from '../store/document-tabs-store';
import type { DocumentTab } from '../store/document-tabs-store';
import { usePdfStore } from '../store/pdf-store';
import {
  DEFAULT_VIEW_SNAPSHOT,
  MAX_SESSION_TABS,
  useSessionStore,
} from '../store/session-store';
import type { RecentDocument, SessionState, SessionTabRecord } from '../store/session-store';
import { useSessionRestoreStore } from '../store/session-restore-store';
import type { OpenPdfResult } from '../types/ipc-protocol';
import { ipc } from './ipc-client';

/**
 * Startup restore engine (work package Q2).
 *
 * The saved session is a list of *locators plus view snapshots*, so restoring it
 * means re-opening each document through the bridge the way the tab bar does,
 * and then replaying the snapshot. The desktop re-opens local paths / source
 * URLs; the browser activates server registry ids and can only fall back to a
 * URL when the session recorded one (an upload has no content to re-create).
 *
 * Everything here is best effort and bounded:
 *
 * - it runs at most once per page load (`restoreAttempted`, set synchronously
 *   before the first `await`, so React StrictMode's double-invoked effect cannot
 *   start it twice), and only when no document is open;
 * - documents are opened serially, in tab order, at most `MAX_SESSION_TABS`;
 * - one failure skips that document (name/kind go to
 *   `session-restore-store`) and the rest continue;
 * - if the user opens another document while the loop is running, the loop
 *   stops without touching that document;
 * - nothing is thrown at the caller: progress and errors are store state.
 *
 * Reusing `restoreViewSnapshot`/`clampSnapshotPage` from the tab bar is
 * deliberate — a restored tab must look exactly like a tab switched to later,
 * and duplicating that logic would let the two drift apart.
 *
 * Q3 adds one entry point that shares this machinery:
 * `openRecentDocument` opens a single recent-list record through the same
 * locator rules and web fallback, but at the default view (a recent entry is not
 * a tab snapshot). Sharing the opener keeps "recent" and "restore" from
 * disagreeing about which records can come back.
 */

/** The restoring action a session record resolves to. */
export type RestoreAction = 'path' | 'url' | 'activate';

export interface RestorePlanEntry {
  /** Position in the saved tab order (not the position in `entries`). */
  index: number;
  record: SessionTabRecord;
  action: RestoreAction;
}

export interface RestorePlan {
  /** Documents to open, in tab order. */
  entries: RestorePlanEntry[];
  /**
   * Index into `entries` of the tab that was active last time, or -1 when that
   * tab was dropped (or the saved index does not describe any tab).
   */
  activeEntryIndex: number;
  /** Records dropped because the locator their kind needs is missing. */
  skipped: SessionTabRecord[];
}

/**
 * How a record can be re-opened, or null when it cannot be.
 *
 * `web` is a URL document that also has a registry id: the id is preferred, the
 * URL is the fallback. `upload` has no URL at all — without its id there is
 * nothing to open.
 */
export function restoreAction(record: SessionTabRecord): RestoreAction | null {
  switch (record.kind) {
    case 'local':
      return record.path ? 'path' : null;
    case 'url':
      return (record.sourceUrl ?? record.path) ? 'url' : null;
    case 'web':
      if (record.documentId) return 'activate';
      return record.sourceUrl ? 'url' : null;
    case 'upload':
      return record.documentId ? 'activate' : null;
    default:
      return null;
  }
}

/**
 * Decide what to open, in which order, without touching any store.
 *
 * Bounded like the session itself: a session longer than `MAX_SESSION_TABS` is
 * truncated (only reachable through a hand-written store state; the persisted
 * record is already capped on load).
 */
export function buildRestorePlan(
  session: Pick<SessionState, 'tabs' | 'activeIndex'>,
): RestorePlan {
  const tabs = session.tabs.slice(0, MAX_SESSION_TABS);
  const entries: RestorePlanEntry[] = [];
  const skipped: SessionTabRecord[] = [];
  let activeEntryIndex = -1;

  tabs.forEach((record, index) => {
    const action = restoreAction(record);
    if (!action) {
      skipped.push(record);
      return;
    }
    if (index === session.activeIndex) activeEntryIndex = entries.length;
    entries.push({ index, record, action });
  });

  return { entries, activeEntryIndex, skipped };
}

type OpenedSessionDocument = Extract<OpenPdfResult, { canceled: false }>;

/** A canceled open cannot be restored; treat it as a skipped document. */
function expectOpened(result: OpenPdfResult, name: string): OpenedSessionDocument {
  if (result.canceled) throw new Error(`Restoring ${name} was canceled`);
  return result;
}

interface RestoredEntry {
  result: OpenedSessionDocument;
  /** The activation was healed through the record's source URL. */
  renewed: boolean;
}

/**
 * Open one planned record through the bridge its kind calls for.
 *
 * A `PdfDocumentNotFoundError` from a web activation is healed through the
 * record's source URL (the server downloads it again under a fresh id). An
 * upload has no URL, so the error is re-thrown and the document is skipped: the
 * restore must never invent content the server no longer has.
 */
async function openPlanEntry(entry: RestorePlanEntry): Promise<RestoredEntry> {
  const { record, action } = entry;

  if (action === 'path') {
    const path = record.path as string;
    return { result: expectOpened(await ipc.openPdfPath(path), record.name), renewed: false };
  }

  if (action === 'url') {
    const url = record.sourceUrl ?? record.path;
    if (!url) throw new Error(`Restoring ${record.name} has no URL`);
    return { result: expectOpened(await ipc.openPdfUrl(url), record.name), renewed: false };
  }

  const documentId = record.documentId;
  if (!documentId) throw new Error(`Restoring ${record.name} has no document id`);

  try {
    return {
      result: expectOpened(await ipc.activatePdfDocument(documentId), record.name),
      renewed: false,
    };
  } catch (error) {
    // Only a web record still knows where its document came from; an upload
    // would have to be re-selected by the user, which is not a restore.
    if (record.kind !== 'web' || !record.sourceUrl) throw error;
    if (!(error instanceof PdfDocumentNotFoundError)) throw error;

    console.warn(
      'Session restore: document id is stale, re-opening its source URL:',
      record.sourceUrl,
      error,
    );
    return { result: expectOpened(await ipc.openPdfUrl(record.sourceUrl), record.name), renewed: true };
  }
}

/**
 * Put an opened document on screen as a tab, exactly like a tab switch would.
 *
 * Order matters: `setFile` resets the view (page 1, cleared search), `addTab`
 * captures that fresh view, and only then are the saved locators/snapshot put
 * back. `navigate` restores the page last so `saveActiveSnapshot` captures the
 * final state instead of the reset one.
 */
async function applyOpenedDocument(
  record: SessionTabRecord,
  opened: RestoredEntry,
  navigate: (page: number) => Promise<void>,
): Promise<{ tab: DocumentTab; path: string }> {
  const { result, renewed } = opened;
  // A healed activation may come back under a new registry id (or none at all);
  // keeping the dead id would make every later activate/close 404.
  const documentId = result.documentId ?? (renewed ? null : record.documentId);
  const sourceUrl = result.sourceUrl ?? record.sourceUrl ?? null;
  const name = record.name || result.name || result.path;

  usePdfStore
    .getState()
    .setFile(result.path, result.metadata, sourceUrl, result.name ?? record.name ?? null);

  const store = useDocumentTabsStore.getState();
  const tab = store.addTab(
    { path: result.path, metadata: result.metadata, sourceUrl, documentId, name },
    name,
  );
  store.updateTab(tab.id, {
    path: result.path,
    metadata: result.metadata,
    sourceUrl,
    documentId,
    name,
    snapshot: record.snapshot,
  });
  store.activate(tab.id);

  restoreViewSnapshot(record.snapshot);
  // Guarded navigation: `navigate` ignores pages outside the new document.
  await navigate(clampSnapshotPage(record.snapshot.currentPage, result.metadata.pages));

  const refreshed: DocumentTab = {
    ...tab,
    path: result.path,
    metadata: result.metadata,
    sourceUrl,
    documentId,
    name,
    snapshot: record.snapshot,
  };
  useDocumentTabsStore.getState().saveActiveSnapshot();
  useSessionStore.getState().recordOpen(refreshed);

  return { tab: refreshed, path: result.path };
}

/**
 * Reduce a recent-list entry to the locator + snapshot shape the opener needs.
 *
 * A recent entry is *not* a tab snapshot: it remembers where the document is,
 * not how it was being viewed when it was last closed. Opening it therefore
 * applies the default view (page 1, zoom 100%) exactly like a first open, and
 * the synthetic snapshot only exists so the shared opener has a record to work
 * with.
 */
export function sessionRecordFromRecent(record: RecentDocument): SessionTabRecord {
  return {
    kind: record.kind,
    path: record.path,
    sourceUrl: record.sourceUrl,
    documentId: record.documentId,
    name: record.name,
    snapshot: { ...DEFAULT_VIEW_SNAPSHOT, overlayVisibility: {} },
    lastActiveAt: record.openedAt,
  };
}

export interface OpenRecentDocumentOptions {
  /** Page navigation, injected for the same reason `restoreSession` takes it. */
  navigate: (page: number) => Promise<void>;
}

/**
 * Open one recent-list entry as the active document (Q3).
 *
 * Deliberately reuses the restore engine's opener, so the "recent" and
 * "restore" paths can never disagree about what counts as a usable locator or
 * about the web recovery rule: a stale registry id on a URL document is healed
 * through its source URL, while an upload with a forgotten id fails instead of
 * inventing content the server no longer has.
 *
 * On success the document becomes a tab (when the build can switch documents),
 * is recorded again as the newest recent entry, and the page is reset to 1 with
 * 100% zoom because a recent entry carries no view snapshot. Failures are thrown
 * to the caller, which owns the row-level error message; no store is left
 * half-applied by a rejected open because nothing is written before it resolves.
 */
export async function openRecentDocument(
  record: RecentDocument,
  options: OpenRecentDocumentOptions,
): Promise<DocumentTab> {
  const planRecord = sessionRecordFromRecent(record);
  const action = restoreAction(planRecord);
  if (!action) throw new Error(`Recent document ${record.name} has no usable location`);

  const { result, renewed } = await openPlanEntry({ index: 0, record: planRecord, action });
  // A healed activation may come back under a new registry id (or none at all);
  // keeping the dead id would make the next open fail again.
  const documentId = result.documentId ?? (renewed ? null : planRecord.documentId);
  const sourceUrl = result.sourceUrl ?? planRecord.sourceUrl;
  const name = planRecord.name || result.name || result.path;
  const trackTabs = supportsDocumentTabs();

  // The outgoing document keeps its page/zoom/panel state, like a tab switch.
  if (trackTabs) useDocumentTabsStore.getState().saveActiveSnapshot();

  const pdf = usePdfStore.getState();
  pdf.setFile(result.path, result.metadata, sourceUrl, result.name ?? planRecord.name ?? null);
  pdf.setZoom(DEFAULT_VIEW_SNAPSHOT.zoom);

  // `addTab` captures the live view, which is now the default one, so the new
  // tab's snapshot matches what the user sees. A build without the tab bridge
  // still records the open, using a tab-shaped value that only feeds the recent
  // list (its id is never shown or activated).
  const tab: DocumentTab = trackTabs
    ? useDocumentTabsStore
        .getState()
        .addTab({ path: result.path, metadata: result.metadata, sourceUrl, documentId, name }, name)
    : {
        id: `recent-${record.id}`,
        path: result.path,
        sourceUrl,
        documentId,
        name,
        metadata: result.metadata,
        snapshot: planRecord.snapshot,
      };

  useSessionStore.getState().recordOpen(tab);
  await options.navigate(DEFAULT_VIEW_SNAPSHOT.currentPage);

  return tab;
}

/** Set once a restore has been started, so a second mount can never repeat it. */
let restoreAttempted = false;

/** Whether this page load already ran (or refused to run) the startup restore. */
export function hasSessionRestoreRun(): boolean {
  return restoreAttempted;
}

/** Test hook: forget the once-per-page-load guard. */
export function resetSessionRestoreGuard(): void {
  restoreAttempted = false;
}

export interface RestoreSessionOptions {
  /**
   * Page navigation (`usePageNavigation`). Injected because the engine is not a
   * hook; the App-level hook passes the same one the tab bar uses.
   */
  navigate: (page: number) => Promise<void>;
  /** External cancellation check, consulted before and after every open. */
  isCancelled?: () => boolean;
  /**
   * Restore even when the automatic-restore preference is off.
   *
   * Set only by an explicit user action (`Restore last session` on the empty
   * state or in the command palette). The preference governs what happens
   * unattended at startup; a click means the user wants the session back now.
   * It never overrides the other preconditions: an open document and an empty
   * saved session still refuse the restore.
   *
   * A forced call also runs outside the once-per-page-load guard. That guard
   * only protects the unattended startup attempt from React StrictMode; the
   * startup attempt has already consumed it (even when it refused to run), so
   * letting the guard apply here would swallow every explicit request made
   * later in the page's life. An explicit request therefore always starts a
   * new run, without callers having to reset the guard first.
   */
  force?: boolean;
}

/**
 * Restore the saved session, once, when nothing is open.
 *
 * Returns whether any document was restored; callers never need to catch.
 */
export async function restoreSession(options: RestoreSessionOptions): Promise<boolean> {
  // Synchronous guard: StrictMode's second effect invocation happens before the
  // first async open settles, so a flag read inside the loop would be too late.
  //
  // It covers the *unattended* startup attempt only. A forced call is an
  // explicit user request made later in the page's life, after the startup
  // attempt already consumed the guard (even when it refused to run), so the
  // guard must not swallow it.
  if (!options.force) {
    if (restoreAttempted) return false;
    restoreAttempted = true;
  }

  const session = useSessionStore.getState();
  // The preference only suppresses the *unattended* startup restore; a manual
  // request (`force`) restores the same session even when it is off.
  if (!options.force && !session.restoreLastSession) return false;
  if (session.tabs.length === 0 || session.tabs.length > MAX_SESSION_TABS) return false;
  // The user already has a document (command line, drag/drop, a fast click):
  // restoring would steal it.
  if (usePdfStore.getState().filePath !== null) return false;
  if (!supportsDocumentTabs()) return false;

  const plan = buildRestorePlan(session);
  if (plan.entries.length === 0) {
    // Every saved locator is unusable; keeping the session would only make the
    // next start retry documents that cannot come back.
    useSessionStore.getState().clearSession();
    return false;
  }

  const progress = useSessionRestoreStore.getState();
  progress.begin(plan.entries.length);

  /** Path of the document this run last put on screen (null before the first). */
  let restoredPath: string | null = usePdfStore.getState().filePath;
  let cancelled = false;
  const restoredIndexes = new Set<number>();
  let lastRestoredIndex = -1;

  // A different path than the one this run left on screen means the user (or
  // another entry point) just opened a document; the restore must yield to it.
  const userTookOver = (): boolean =>
    (options.isCancelled?.() ?? false) || usePdfStore.getState().filePath !== restoredPath;

  try {
    for (const entry of plan.entries) {
      if (userTookOver()) {
        cancelled = true;
        break;
      }

      try {
        const opened = await openPlanEntry(entry);
        // The open is asynchronous: a document may have been opened meanwhile,
        // and applying the result would overwrite it.
        if (userTookOver()) {
          cancelled = true;
          break;
        }

        const { path } = await applyOpenedDocument(entry.record, opened, options.navigate);
        restoredPath = path;
        restoredIndexes.add(entry.index);
        lastRestoredIndex = entry.index;
        useSessionRestoreStore.getState().advance();
      } catch (error) {
        console.error('Failed to restore session document:', entry.record.name, error);
        useSessionRestoreStore.getState().recordFailure({
          name: entry.record.name,
          kind: entry.record.kind,
        });
        // An open can fail *after* `setFile` (the page extraction the snapshot
        // navigation triggers, for example): the document on screen is still the
        // one this run left there, so the next iteration must not mistake it for
        // a user takeover and abandon the remaining tabs.
        restoredPath = usePdfStore.getState().filePath;
        useSessionRestoreStore.getState().advance();
      }
    }

    // The last opened tab is active by construction; only an earlier tab needs
    // to be brought back. Re-running the recorded open is what the tab bar does
    // for a switch, and it is skipped for a tab that already failed above.
    if (!cancelled && plan.activeEntryIndex >= 0) {
      const activeEntry = plan.entries[plan.activeEntryIndex];
      const shouldReactivate =
        restoredIndexes.has(activeEntry.index) && lastRestoredIndex !== activeEntry.index;

      if (shouldReactivate && !userTookOver()) {
        try {
          const opened = await openPlanEntry(activeEntry);
          if (userTookOver()) {
            // Same rule as above: the user is driving now, so nothing is applied
            // and the session is left for the tab bar to save.
            cancelled = true;
          } else {
            await applyOpenedDocument(activeEntry.record, opened, options.navigate);
          }
        } catch (error) {
          // The document itself is already open: this second open only failed to
          // make it the active tab, so it was restored and must not be reported
          // as a document that could not be restored.
          console.error('Failed to re-activate the last active session tab:', error);
        }
      }
    }

    // Re-save the surviving tabs so dead entries are evicted now instead of
    // being retried on every start. A cancelled run must not write over the
    // document the user just opened on top of it.
    if (!cancelled) {
      const tabs = useDocumentTabsStore.getState();
      useSessionStore.getState().saveTabs(tabs.tabs, tabs.activeTabId);
    }
  } catch (error) {
    console.error('Session restore stopped:', error);
    useSessionRestoreStore
      .getState()
      .fail(error instanceof Error ? error.message : 'Failed to restore the last session');
  } finally {
    useSessionRestoreStore.getState().finish();
  }

  return restoredIndexes.size > 0;
}

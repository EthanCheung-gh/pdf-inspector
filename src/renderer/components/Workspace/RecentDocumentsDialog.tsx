import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useI18nStore, useT, type MessageKey } from '../../i18n';
import { usePageNavigation } from '../../hooks/usePageNavigation';
import { openRecentDocument } from '../../services/session-restore';
import { useSessionStore } from '../../store/session-store';
import type { RecentDocument, SessionTabKind } from '../../store/session-store';
import { useSessionUiStore } from '../../store/session-ui-store';
import styles from './RecentDocumentsDialog.module.css';

/**
 * Recent-documents dialog (work package Q3).
 *
 * The list itself lives in `session-store` (persisted locally, capped at 20,
 * deduplicated by identity); this component only groups, renders and opens it.
 *
 * Grouping follows the plan — local files, URL documents, web documents — with
 * uploads folded into the web group because they share the same server-side
 * registry. The two differ in the opener, never in the layout: a web record can
 * heal a dead registry id through its source URL, an upload cannot and reports a
 * row error telling the user to re-upload (no content and no local path is
 * stored for it anywhere).
 *
 * Opening reuses `openRecentDocument`, which is the restore engine's opener, so
 * "recent" and "restore" agree on what is re-openable and on the web fallback.
 * Errors stay on the row that caused them and the dialog stays open, so one dead
 * entry never hides the rest of the list.
 */

export type RecentGroupId = 'local' | 'url' | 'web';

export interface RecentGroup {
  id: RecentGroupId;
  titleKey: MessageKey;
  records: RecentDocument[];
}

const GROUP_TITLE_KEYS: Record<RecentGroupId, MessageKey> = {
  local: 'recent.group.local',
  url: 'recent.group.url',
  web: 'recent.group.web',
};

const KIND_LABEL_KEYS: Record<SessionTabKind, MessageKey> = {
  local: 'recent.kind.local',
  url: 'recent.kind.url',
  web: 'recent.kind.web',
  upload: 'recent.kind.upload',
};

/** Which group a record belongs to; `web` collects URL documents and uploads. */
export function recentGroupId(kind: SessionTabKind): RecentGroupId {
  if (kind === 'local') return 'local';
  if (kind === 'url') return 'url';
  return 'web';
}

/**
 * Group the store's (already newest-first) list for display.
 *
 * Order inside a group is preserved, so the most recently opened document stays
 * first everywhere. Empty groups are dropped: the dialog only renders sections
 * that actually have rows.
 */
export function groupRecentDocuments(recent: readonly RecentDocument[]): RecentGroup[] {
  const groups: Record<RecentGroupId, RecentDocument[]> = { local: [], url: [], web: [] };
  for (const record of recent) groups[recentGroupId(record.kind)].push(record);

  return (['local', 'url', 'web'] as const)
    .filter((id) => groups[id].length > 0)
    .map((id) => ({ id, titleKey: GROUP_TITLE_KEYS[id], records: groups[id] }));
}

/**
 * The path/URL shown under a row's name.
 *
 * A local record shows its path, a URL record its source URL, and a web record
 * its source URL when it has one. An upload has no local path at all (that is
 * the privacy boundary); its display path is server-side and only used as a
 * last resort so the row is not empty.
 */
export function recentDocumentLocation(record: RecentDocument): string {
  return record.sourceUrl ?? record.path ?? record.name;
}

/**
 * Format a recent entry's timestamp for display. The `time` element keeps the
 * ISO value in `dateTime`, so tests and ATs do not depend on the locale string.
 */
export function formatRecentOpenedAt(openedAt: number, locale: string): string {
  if (!Number.isFinite(openedAt) || openedAt <= 0) return '';
  const date = new Date(openedAt);
  if (Number.isNaN(date.getTime())) return '';
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
  } catch {
    return date.toISOString();
  }
}

export const RecentDocumentsDialog: React.FC = () => {
  const t = useT();
  const { navigate } = usePageNavigation();
  const open = useSessionUiStore((state) => state.recentDialogOpen);
  const close = useSessionUiStore((state) => state.closeRecentDialog);
  const recent = useSessionStore((state) => state.recent);
  const restoreLastSession = useSessionStore((state) => state.restoreLastSession);
  const setRestoreLastSession = useSessionStore((state) => state.setRestoreLastSession);
  const removeRecent = useSessionStore((state) => state.removeRecent);
  const clearRecent = useSessionStore((state) => state.clearRecent);
  const locale = useI18nStore((state) => state.locale);

  const [openingId, setOpeningId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  // Fresh transient state and focus on every open. The element that had focus is
  // remembered so closing the dialog (Close, Escape, backdrop) returns the user
  // to the entry point they came from; if that element was unmounted meanwhile
  // (for example a palette item, or a document open replacing the empty state),
  // there is nothing sensible to restore.
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setOpeningId(null);
    setRowError(null);
    setConfirmClear(false);
    dialogRef.current?.focus();

    return () => {
      if (opener && opener.isConnected) opener.focus();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;

    // Capture phase so the app-level Escape handler (window, bubble phase) never
    // also clears the Inspect selection while the dialog is open.
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      close();
    };

    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [close, open]);

  const openRecord = useCallback(
    async (record: RecentDocument): Promise<void> => {
      if (openingId !== null) return;
      setRowError(null);
      setOpeningId(record.id);
      try {
        await openRecentDocument(record, { navigate });
        close();
      } catch (err) {
        // A dead entry (moved file, expired web id, forgotten upload) is a row
        // error, not a dialog error: the rest of the list stays usable.
        console.error('Failed to open recent document:', record.name, err);
        // An upload has no content or URL to recover from, so the generic
        // "could not open" would hide the one action the user can take. Say
        // plainly that the earlier session's upload is gone and must be
        // uploaded again instead of implying the document might still exist.
        const message =
          record.kind === 'upload'
            ? t('recent.uploadUnavailable', { name: record.name })
            : t('recent.openFailed', { name: record.name });
        setRowError({ id: record.id, message });
      } finally {
        setOpeningId(null);
      }
    },
    [close, navigate, openingId, t],
  );

  const handleBackdropClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (event.target !== event.currentTarget) return;
      close();
    },
    [close],
  );

  if (!open) return null;

  const groups = groupRecentDocuments(recent);

  return (
    <div className={styles.backdrop} onClick={handleBackdropClick}>
      <div
        ref={dialogRef}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <h2 id={titleId} className={styles.title}>
          {t('recent.title')}
        </h2>

        <div className={styles.listArea}>
          {groups.length === 0 ? (
            <div className={styles.empty}>
              <p className={styles.emptyTitle}>{t('recent.empty.title')}</p>
              <p className={styles.emptyBody}>{t('recent.empty.body')}</p>
            </div>
          ) : (
            groups.map((group) => (
              <section key={group.id} className={styles.group} aria-label={t(group.titleKey)}>
                <h3 className={styles.groupTitle}>{t(group.titleKey)}</h3>
                <ul className={styles.list}>
                  {group.records.map((record) => {
                    const location = recentDocumentLocation(record);
                    const openedAt = formatRecentOpenedAt(record.openedAt, locale);
                    const opening = openingId === record.id;
                    return (
                      <li key={record.id} className={styles.row} data-testid={`recent-row-${record.id}`}>
                        <div className={styles.rowMain}>
                          {/* Names, paths and URLs are user data: never translated. */}
                          <span className={styles.rowName} title={record.name}>
                            {record.name}
                          </span>
                          <span className={styles.rowLocation} title={location}>
                            {location}
                          </span>
                          {rowError?.id === record.id && (
                            <span className={styles.rowError} role="alert">
                              {rowError.message}
                            </span>
                          )}
                        </div>
                        <span className={styles.rowKind}>{t(KIND_LABEL_KEYS[record.kind])}</span>
                        {openedAt && (
                          <time
                            className={styles.rowTime}
                            dateTime={new Date(record.openedAt).toISOString()}
                          >
                            {openedAt}
                          </time>
                        )}
                        <div className={styles.rowActions}>
                          <button
                            className={styles.button}
                            type="button"
                            aria-label={t('recent.openTitle', { name: record.name })}
                            disabled={openingId !== null}
                            onClick={() => void openRecord(record)}
                          >
                            {opening ? t('recent.opening') : t('recent.open')}
                          </button>
                          <button
                            className={styles.button}
                            type="button"
                            aria-label={t('recent.removeTitle', { name: record.name })}
                            disabled={openingId !== null}
                            onClick={() => {
                              setRowError((current) => (current?.id === record.id ? null : current));
                              removeRecent(record.id);
                            }}
                          >
                            {t('recent.remove')}
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))
          )}
        </div>

        <p className={styles.privacy}>{t('recent.privacy')}</p>

        <div className={styles.footer}>
          <label className={styles.toggle}>
            <input
              type="checkbox"
              checked={restoreLastSession}
              onChange={(event) => setRestoreLastSession(event.target.checked)}
            />
            <span>{t('recent.restoreLastSession')}</span>
          </label>

          <div className={styles.footerActions}>
            {openingId !== null && (
              <span className={styles.status} role="status" aria-live="polite">
                {t('recent.opening')}
              </span>
            )}
            {confirmClear ? (
              <span
                className={styles.confirm}
                role="group"
                aria-label={t('recent.clearConfirmQuestion')}
              >
                <span className={styles.confirmText}>{t('recent.clearConfirmQuestion')}</span>
                <button
                  className={styles.button}
                  type="button"
                  onClick={() => {
                    clearRecent();
                    setConfirmClear(false);
                    setRowError(null);
                  }}
                >
                  {t('recent.clearConfirm')}
                </button>
                <button
                  className={styles.button}
                  type="button"
                  onClick={() => setConfirmClear(false)}
                >
                  {t('common.cancel')}
                </button>
              </span>
            ) : (
              <button
                className={styles.button}
                type="button"
                disabled={recent.length === 0}
                onClick={() => setConfirmClear(true)}
              >
                {t('recent.clear')}
              </button>
            )}
            <button className={styles.button} type="button" onClick={close}>
              {t('recent.close')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

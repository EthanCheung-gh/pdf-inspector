import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { usePageNavigation } from '../../hooks/usePageNavigation';
import { useT } from '../../i18n';
import {
  pageThumbnails,
  type ThumbnailDocument,
  type ThumbnailLoader,
} from '../../services/page-thumbnails';
import { usePageOverviewStore } from '../../store/page-overview-store';
import { usePdfStore } from '../../store/pdf-store';
import styles from './PageOverview.module.css';

/**
 * Page overview (work package T2).
 *
 * A modal grid of one card per page. Cards render a cached thumbnail through
 * the injected `ThumbnailLoader` (default: the shared `pageThumbnails`) and a
 * click navigates and closes the dialog. Thumbnail work is lazy: a single
 * `IntersectionObserver` rooted at the scroll container marks cards near the
 * viewport as visible, so a 1000-page document does not request 1000 renders.
 *
 * Accessibility/lifecycle rules:
 * - the dialog traps Tab, closes on Escape/backdrop/close button, and restores
 *   focus to the element that opened it;
 * - opening focuses and scrolls to the current page;
 * - arrows move focus by one page (left/right) or one grid row (up/down, using
 *   the computed column count), Home/End jump to the first/last page, and
 *   Enter/Space stay the button's native activation;
 * - a document change closes the dialog so page numbers and thumbnails from
 *   two documents are never mixed.
 */
interface PageOverviewProps {
  /** Test seam: a loader that resolves JPEG data URLs for a page. */
  loader?: Pick<ThumbnailLoader, 'load'>;
}

type ThumbnailStatus = 'loading' | 'ready' | 'error';

const FALLBACK_COLUMNS = 4;
const OBSERVER_ROOT_MARGIN = '300px';
/** Extra pages seeded around the current page before the observer reports. */
const INITIAL_VISIBLE_BEFORE = 2;
const INITIAL_VISIBLE_AFTER = 5;

interface PageThumbnailProps {
  document: ThumbnailDocument | null;
  loader: Pick<ThumbnailLoader, 'load'>;
  page: number;
  /** False until the parent's observer reports the card near the viewport. */
  visible: boolean;
  loadingLabel: string;
  failedLabel: string;
}

/**
 * One card's image area. The loader is only touched once the card is visible,
 * and a failure stays local to this card: the button still navigates.
 *
 * The labels are passed in rather than read via `useT()` so a 1000-page grid
 * holds one locale subscription (the dialog), not one per card.
 */
const PageThumbnail: React.FC<PageThumbnailProps> = ({
  document: pdfDocument,
  loader,
  page,
  visible,
  loadingLabel,
  failedLabel,
}) => {
  const [status, setStatus] = useState<ThumbnailStatus>('loading');
  const [source, setSource] = useState<string | null>(null);
  const requestedRef = useRef(false);

  useEffect(() => {
    if (!visible) {
      // Leaving the viewport releases the data URL: otherwise a 1000-page
      // scroll retains every visited <img>, bypassing the loader's LRU. A
      // later re-entry requests again (the loader cache usually answers it).
      requestedRef.current = false;
      setStatus('loading');
      setSource(null);
      return;
    }
    if (!pdfDocument || requestedRef.current) return;
    requestedRef.current = true;

    let cancelled = false;
    setStatus('loading');
    setSource(null);

    let request: Promise<string>;
    try {
      request = loader.load(pdfDocument, page);
    } catch {
      // A loader that throws synchronously is still just one broken thumbnail.
      setStatus('error');
      return;
    }

    request.then(
      (dataUrl) => {
        if (cancelled) return;
        setSource(dataUrl);
        setStatus('ready');
      },
      () => {
        if (!cancelled) setStatus('error');
      },
    );

    return () => {
      // The dialog closed, the card left the viewport or the document changed
      // while rendering; the result belongs to a card that is gone.
      cancelled = true;
    };
  }, [loader, page, pdfDocument, visible]);

  return (
    <span className={styles.thumbnailFrame}>
      {status === 'ready' && source ? (
        <img className={styles.thumbnailImage} src={source} alt="" draggable={false} />
      ) : status === 'error' ? (
        <span
          className={styles.thumbnailError}
          data-testid="thumbnail-error"
          role="img"
          aria-label={failedLabel}
          title={failedLabel}
        >
          !
        </span>
      ) : (
        <span
          className={styles.thumbnailSkeleton}
          data-testid="thumbnail-skeleton"
          role="img"
          aria-label={loadingLabel}
        />
      )}
    </span>
  );
};

const focusAndCenter = (element: HTMLElement): void => {
  try {
    element.focus();
  } catch {
    // A detached node cannot receive focus; nothing else to do.
  }
  try {
    element.scrollIntoView({ block: 'center' });
  } catch {
    // jsdom (and very old engines) do not implement scrollIntoView.
  }
};

const readPageNumber = (element: Element | null): number | null => {
  if (!(element instanceof HTMLElement)) return null;
  const raw = element.dataset.page;
  if (!raw) return null;
  const page = Number(raw);
  return Number.isInteger(page) && page >= 1 ? page : null;
};

export const PageOverview: React.FC<PageOverviewProps> = ({ loader = pageThumbnails }) => {
  const t = useT();
  const open = usePageOverviewStore((state) => state.open);
  const closeOverview = usePageOverviewStore((state) => state.closeOverview);

  const pageCount = usePdfStore((state) => state.pageCount);
  const currentPage = usePdfStore((state) => state.currentPage);
  const pdfDocRef = usePdfStore((state) => state.pdfDocRef);
  const filePath = usePdfStore((state) => state.filePath);
  const documentEpoch = usePdfStore((state) => state.documentEpoch);

  const { navigate } = usePageNavigation();

  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  /** Last document identity seen, to detect a switch while the dialog is open. */
  const documentKeyRef = useRef<string | null>(null);

  const [visiblePages, setVisiblePages] = useState<ReadonlySet<number>>(() => new Set());

  // A document switch or an empty document invalidates the whole grid. These
  // effects run after the render that observes the change, which is why the
  // dialog also hides itself while `open` is still true but the document is
  // gone (see the early return below).
  const documentKey = `${documentEpoch}\u0000${filePath ?? ''}`;
  const documentChanged = documentKeyRef.current !== null && documentKeyRef.current !== documentKey;

  useEffect(() => {
    if (!open) return;
    if (!filePath || pageCount < 1) closeOverview();
  }, [closeOverview, filePath, open, pageCount]);

  useEffect(() => {
    const previous = documentKeyRef.current;
    documentKeyRef.current = documentKey;
    if (previous === null || previous === documentKey) return;
    if (open) closeOverview();
  }, [closeOverview, documentKey, open]);

  // Save the opener as the dialog appears and restore it on close/unmount. The
  // cleanup runs exactly when `open` flips to false (or the app unmounts).
  useEffect(() => {
    if (!open) return;
    const active = document.activeElement;
    const opener = active instanceof HTMLElement ? active : null;
    return () => {
      if (opener && opener.isConnected) {
        try {
          opener.focus();
        } catch {
          // The opener was removed while the dialog was open.
        }
      }
    };
  }, [open]);

  // Opening focuses the current page card (and centers it). If the card is not
  // there yet, the dialog itself takes focus so keyboard input still lands in
  // the trap.
  useEffect(() => {
    if (!open || pageCount < 1) return;
    const card = gridRef.current?.querySelector<HTMLElement>(
      `[data-page="${currentPage}"]`,
    );
    if (card) {
      focusAndCenter(card);
    } else {
      dialogRef.current?.focus();
    }
  }, [currentPage, open, pageCount]);

  // Closing discards the visibility window (the cards unmount), so the next
  // open seeds around whatever page is current then. This reset lives outside
  // the observer effect on purpose: that effect must never clear a set the
  // observer has already grown.
  useEffect(() => {
    if (open) return;
    setVisiblePages((previous) => (previous.size === 0 ? previous : new Set()));
  }, [open]);

  // One observer per document/grid. It only marks pages as visible; the cards
  // own the actual load. Environments without IntersectionObserver (jsdom)
  // fall back to "everything visible" so the dialog remains testable.
  useEffect(() => {
    if (!open || pageCount < 1) return;

    if (typeof IntersectionObserver === 'undefined') {
      setVisiblePages(new Set(Array.from({ length: pageCount }, (_value, index) => index + 1)));
      return;
    }

    // A 1000-card grid does not reliably deliver an initial intersecting batch
    // (the first paint can beat the observer), which left every card with a
    // skeleton until the user scrolled. Seed the viewport around the current
    // page ourselves and never overwrite a set the observer already grew.
    setVisiblePages((previous) => {
      if (previous.size > 0) return previous;
      const first = Math.max(1, currentPage - INITIAL_VISIBLE_BEFORE);
      const last = Math.min(pageCount, currentPage + INITIAL_VISIBLE_AFTER);
      const seeded = new Set<number>();
      for (let page = first; page <= last; page += 1) seeded.add(page);
      return seeded;
    });

    const cards = gridRef.current?.querySelectorAll<HTMLElement>('[data-page]') ?? [];

    const observer = new IntersectionObserver(
      (entries) => {
        const entering = new Set<number>();
        const leaving = new Set<number>();
        for (const entry of entries) {
          const page = readPageNumber(entry.target);
          if (page === null) continue;
          if (entry.isIntersecting) {
            entering.add(page);
          } else {
            leaving.add(page);
          }
        }
        if (entering.size === 0 && leaving.size === 0) return;

        setVisiblePages((previous) => {
          let changed = false;
          const next = new Set(previous);
          entering.forEach((page) => {
            if (next.has(page)) return;
            next.add(page);
            changed = true;
          });
          // The rootMargin keeps the card alive until it is well outside the
          // viewport; past that point its data URL is released so a long
          // scroll cannot retain every visited JPEG.
          leaving.forEach((page) => {
            if (!next.has(page)) return;
            next.delete(page);
            changed = true;
          });
          return changed ? next : previous;
        });
      },
      { root: scrollerRef.current, rootMargin: OBSERVER_ROOT_MARGIN },
    );

    cards.forEach((card) => observer.observe(card));
    return () => observer.disconnect();
  }, [currentPage, documentKey, open, pageCount, pdfDocRef]);

  const readColumnCount = useCallback((): number => {
    const grid = gridRef.current;
    if (!grid) return FALLBACK_COLUMNS;
    try {
      const tracks = window.getComputedStyle(grid).gridTemplateColumns;
      const count =
        typeof tracks === 'string' ? tracks.split(/\s+/).filter(Boolean).length : 0;
      return count > 0 ? count : FALLBACK_COLUMNS;
    } catch {
      return FALLBACK_COLUMNS;
    }
  }, []);

  const goToPage = useCallback(
    (page: number) => {
      try {
        void navigate(page).catch((error: unknown) => {
          console.error('Page navigation failed:', error);
        });
      } catch (error) {
        console.error('Page navigation failed:', error);
      }
      closeOverview();
    },
    [closeOverview, navigate],
  );

  const handleBackdropClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      // Only a click on the backdrop itself closes; clicks inside the dialog
      // (including the empty grid area) must not.
      if (event.target !== event.currentTarget) return;
      closeOverview();
    },
    [closeOverview],
  );

  const focusableElements = useCallback((): HTMLElement[] => {
    const dialog = dialogRef.current;
    if (!dialog) return [];
    return Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((element) => element.tabIndex >= 0);
  }, []);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeOverview();
        return;
      }

      if (event.key === 'Tab') {
        const focusables = focusableElements();
        if (focusables.length === 0) {
          event.preventDefault();
          return;
        }
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement;
        const inside = active instanceof HTMLElement && Boolean(dialogRef.current?.contains(active));
        if (event.shiftKey) {
          if (!inside || active === first) {
            event.preventDefault();
            last.focus();
          }
        } else if (!inside || active === last) {
          event.preventDefault();
          first.focus();
        }
        return;
      }

      const focusedPage = readPageNumber(document.activeElement) ?? currentPage;
      let target: number | null = null;
      switch (event.key) {
        case 'ArrowRight':
          target = focusedPage + 1;
          break;
        case 'ArrowLeft':
          target = focusedPage - 1;
          break;
        case 'ArrowDown':
          target = focusedPage + readColumnCount();
          break;
        case 'ArrowUp':
          target = focusedPage - readColumnCount();
          break;
        case 'Home':
          target = 1;
          break;
        case 'End':
          target = pageCount;
          break;
        default:
          return;
      }

      event.preventDefault();
      const clamped = Math.max(1, Math.min(pageCount, target));
      const card = gridRef.current?.querySelector<HTMLElement>(`[data-page="${clamped}"]`);
      if (card) focusAndCenter(card);
    },
    [closeOverview, currentPage, focusableElements, pageCount, readColumnCount],
  );

  if (!open) return null;
  // The close effect above runs after this render; hiding immediately prevents
  // a frame of the new document's page count with the old grid.
  if (!filePath || pageCount < 1 || documentChanged) return null;

  const pages = Array.from({ length: pageCount }, (_value, index) => index + 1);

  return (
    <div
      className={styles.backdrop}
      data-testid="page-overview-backdrop"
      onClick={handleBackdropClick}
    >
      <div
        ref={dialogRef}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        <div className={styles.header}>
          <h2 id={titleId} className={styles.title}>
            {t('pageOverview.title')}
          </h2>
          <button
            type="button"
            className={styles.closeButton}
            aria-label={t('pageOverview.close')}
            title={t('pageOverview.close')}
            onClick={closeOverview}
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>
        <p className={styles.hint}>{t('pageOverview.hint')}</p>
        <div ref={scrollerRef} className={styles.scroller}>
          <div ref={gridRef} className={styles.grid} data-testid="page-overview-grid">
            {pages.map((page) => {
              const current = page === currentPage;
              return (
                <button
                  key={`${documentKey}:${page}`}
                  type="button"
                  className={`${styles.card} ${current ? styles.cardCurrent : ''}`}
                  data-page={page}
                  aria-label={t('pageOverview.pageLabel', { page })}
                  aria-current={current ? 'page' : undefined}
                  onClick={() => goToPage(page)}
                >
                  <PageThumbnail
                    document={pdfDocRef}
                    loader={loader}
                    page={page}
                    visible={visiblePages.has(page)}
                    loadingLabel={t('pageOverview.loading')}
                    failedLabel={t('pageOverview.failed')}
                  />
                  <span className={styles.cardFooter}>
                    <span className={styles.cardLabel}>
                      {t('pageOverview.pageLabel', { page })}
                    </span>
                    {current && (
                      <span className={styles.currentBadge}>{t('pageOverview.current')}</span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
};

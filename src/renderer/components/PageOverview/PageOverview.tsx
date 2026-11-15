import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { annotationDocumentKey } from '../../hooks/useAnnotationIndex';
import { usePageNavigation } from '../../hooks/usePageNavigation';
import {
  translatePlural,
  useI18nStore,
  useT,
  type Locale,
  type MessageKey,
  type TranslateFn,
} from '../../i18n';
import { buildPageMarkers, type PageMarker } from '../../services/page-markers';
import {
  pageThumbnails,
  type ThumbnailDocument,
  type ThumbnailLoader,
} from '../../services/page-thumbnails';
import { useAnnotationIndexStore } from '../../store/annotation-index-store';
import { useAuditStore } from '../../store/audit-store';
import {
  usePageOverviewStore,
  type PageOverviewFilter,
} from '../../store/page-overview-store';
import { usePdfStore } from '../../store/pdf-store';
import styles from './PageOverview.module.css';

/**
 * Page overview (work packages T2 + V2).
 *
 * A modal grid of one card per page. Cards render a cached thumbnail through
 * the injected `ThumbnailLoader` (default: the shared `pageThumbnails`) and a
 * click navigates and closes the dialog. Thumbnail work is lazy: a single
 * `IntersectionObserver` rooted at the scroll container marks cards near the
 * viewport as visible, so a 1000-page document does not request 1000 renders.
 *
 * The grid is also the document map: the current file's audit report and
 * whole-document annotation index are aggregated once (see `page-markers.ts`)
 * and drawn as compact badges on each thumbnail, with a header summary, a
 * document-level count and an `all`/`problems`/`annotated` filter. The overview
 * is a *view* of analyses that already ran: it never starts an audit or an
 * index, and it drops a report/index that belongs to another file.
 *
 * Accessibility/lifecycle rules:
 * - the dialog traps Tab, closes on Escape/backdrop/close button, and restores
 *   focus to the element that opened it;
 * - opening focuses and scrolls to the current page; when the active filter
 *   hides that page, the first rendered card (or the dialog) takes focus;
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
/** Cards seeded when the current page is hidden by the active filter. */
const INITIAL_VISIBLE_FIRST = INITIAL_VISIBLE_AFTER + 1;

const FILTER_OPTIONS: readonly { value: PageOverviewFilter; labelKey: MessageKey }[] = [
  { value: 'all', labelKey: 'pageOverview.filter.all' },
  { value: 'problems', labelKey: 'pageOverview.filter.problems' },
  { value: 'annotated', labelKey: 'pageOverview.filter.annotated' },
];

/** One badge of a page marker: short text, full label and its colour tone. */
interface MarkerPart {
  key: string;
  /** Two-or-three character badge text, e.g. `E2`. */
  short: string;
  /** Localized `title` text, e.g. `2 errors`. */
  label: string;
  tone: 'error' | 'warning' | 'info' | 'annotation' | 'issue';
}

/**
 * The badges of one page, in contract order (error, warning, info, annotation,
 * issue). Zero counts are skipped so a page only shows what it actually has.
 *
 * Labels are pluralized phrases ("1 error", "2 errors"); the badge text itself
 * stays a compact `E2`-style token.
 */
const markerParts = (marker: PageMarker, locale: Locale): MarkerPart[] => {
  const parts: MarkerPart[] = [];
  const { error, warning, info } = marker.findings;

  if (error > 0) {
    parts.push({
      key: 'error',
      short: `E${error}`,
      label: translatePlural(locale, 'pageOverview.marker.error', error),
      tone: 'error',
    });
  }
  if (warning > 0) {
    parts.push({
      key: 'warning',
      short: `W${warning}`,
      label: translatePlural(locale, 'pageOverview.marker.warning', warning),
      tone: 'warning',
    });
  }
  if (info > 0) {
    parts.push({
      key: 'info',
      short: `I${info}`,
      label: translatePlural(locale, 'pageOverview.marker.info', info),
      tone: 'info',
    });
  }
  if (marker.annotations > 0) {
    parts.push({
      key: 'annotations',
      short: `A${marker.annotations}`,
      label: translatePlural(locale, 'pageOverview.marker.annotation', marker.annotations),
      tone: 'annotation',
    });
  }
  if (marker.annotationIssues > 0) {
    parts.push({
      key: 'issues',
      short: `!${marker.annotationIssues}`,
      label: translatePlural(locale, 'pageOverview.marker.issue', marker.annotationIssues),
      tone: 'issue',
    });
  }
  return parts;
};

/**
 * Accessible name of a card: the page label plus every non-zero count, so the
 * badges are never the only indication of a marker. This is the name screen
 * readers announce — the badges inside the button are `aria-hidden`.
 */
const cardLabel = (
  page: number,
  marker: PageMarker | undefined,
  locale: Locale,
  t: TranslateFn,
): string => {
  const base = t('pageOverview.pageLabel', { page });
  if (marker === undefined) return base;
  return [base, ...markerParts(marker, locale).map((part) => part.label)].join(' · ');
};

/**
 * Visibility window seeded before the observer reports.
 *
 * The window is taken from the rendered list, so a filtered grid seeds around
 * the current page when it is part of the filter and falls back to the first
 * cards when it is not (a filter must never open on a full grid of skeletons).
 */
const seedVisiblePages = (pages: readonly number[], currentPage: number): ReadonlySet<number> => {
  const seeded = new Set<number>();
  if (pages.length === 0) return seeded;

  const index = pages.indexOf(currentPage);
  if (index === -1) {
    pages.slice(0, INITIAL_VISIBLE_FIRST).forEach((page) => seeded.add(page));
    return seeded;
  }

  const first = Math.max(0, index - INITIAL_VISIBLE_BEFORE);
  const last = Math.min(pages.length - 1, index + INITIAL_VISIBLE_AFTER);
  for (let position = first; position <= last; position += 1) seeded.add(pages[position]);
  return seeded;
};

interface PageThumbnailProps {
  document: ThumbnailDocument | null;
  loader: Pick<ThumbnailLoader, 'load'>;
  page: number;
  /** False until the parent's observer reports the card near the viewport. */
  visible: boolean;
  loadingLabel: string;
  failedLabel: string;
  /** Audit/annotation badges, overlaid on the frame without changing its size. */
  badges: React.ReactNode;
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
  badges,
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
      {badges}
    </span>
  );
};

const TONE_CLASS: Readonly<Record<MarkerPart['tone'], string>> = {
  error: styles.badgeError,
  warning: styles.badgeWarning,
  info: styles.badgeInfo,
  annotation: styles.badgeAnnotation,
  issue: styles.badgeIssue,
};

/**
 * The badge row of one page, absolutely positioned inside the frame.
 *
 * The badges are `aria-hidden`: they live inside the card button, whose
 * `aria-label` already names every count (`cardLabel`), and a nested label
 * would be overridden by it anyway. Sighted users still get the pluralized
 * `title` tooltip, so the meaning is never colour-only.
 */
const MarkerBadges: React.FC<{ marker: PageMarker; locale: Locale }> = ({ marker, locale }) => {
  const parts = markerParts(marker, locale);
  if (parts.length === 0) return null;

  return (
    <span className={styles.badges}>
      {parts.map((part) => (
        <span
          key={part.key}
          className={`${styles.badge} ${TONE_CLASS[part.tone]}`}
          data-testid={`page-marker-${part.tone}`}
          title={part.label}
          aria-hidden="true"
        >
          {part.short}
        </span>
      ))}
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
  // Counts are phrases ("1 page", "3 pages"), so the summary needs the locale
  // itself, not only the translator.
  const locale = useI18nStore((state) => state.locale);
  const open = usePageOverviewStore((state) => state.open);
  const filter = usePageOverviewStore((state) => state.filter);
  const closeOverview = usePageOverviewStore((state) => state.closeOverview);
  const setFilter = usePageOverviewStore((state) => state.setFilter);

  const pageCount = usePdfStore((state) => state.pageCount);
  const currentPage = usePdfStore((state) => state.currentPage);
  const pdfDocRef = usePdfStore((state) => state.pdfDocRef);
  const filePath = usePdfStore((state) => state.filePath);
  const sourceUrl = usePdfStore((state) => state.sourceUrl);
  const documentEpoch = usePdfStore((state) => state.documentEpoch);

  // Analyses of the *current* file, or null. Both stores outlive a document
  // switch, so the identity check below is what keeps another file's markers
  // (or a report that finished after the switch) off these pages.
  const auditReport = useAuditStore((state) => state.report);
  const auditFilePath = useAuditStore((state) => state.filePath);
  const annotationStatus = useAnnotationIndexStore((state) => state.status);
  const annotationResult = useAnnotationIndexStore((state) => state.result);
  const annotationKey = useAnnotationIndexStore((state) => state.documentKey);

  const { navigate } = usePageNavigation();

  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  /** Last document identity seen, to detect a switch while the dialog is open. */
  const documentKeyRef = useRef<string | null>(null);
  /** Last filter seen, so a filter change can keep focus on its own control. */
  const filterRef = useRef<PageOverviewFilter>(filter);
  /** `<document, filter>` the current visibility window belongs to. */
  const gridKeyRef = useRef<string | null>(null);

  const [visiblePages, setVisiblePages] = useState<ReadonlySet<number>>(() => new Set());

  /**
   * Page markers of the current file: the audit report only when it belongs to
   * `filePath`, the annotation index only when it is ready for this document's
   * key. Both are aggregated once per change, never per card.
   */
  const markers = useMemo(() => {
    const auditReportForMarkers =
      auditReport !== null && auditFilePath !== null && auditFilePath === filePath
        ? auditReport
        : null;
    const annotationResultForMarkers =
      annotationStatus === 'ready' &&
      annotationResult !== null &&
      annotationKey !== null &&
      annotationKey === annotationDocumentKey(filePath, sourceUrl)
        ? annotationResult
        : null;

    return {
      pageMarkers: buildPageMarkers({
        pageCount,
        auditReport: auditReportForMarkers,
        annotationResult: annotationResultForMarkers,
      }),
      hasAuditReport: auditReportForMarkers !== null,
      hasAnnotationIndex: annotationResultForMarkers !== null,
    };
  }, [
    annotationKey,
    annotationResult,
    annotationStatus,
    auditFilePath,
    auditReport,
    filePath,
    pageCount,
    sourceUrl,
  ]);

  /**
   * The rendered page list: every page, or the pages carrying the markers the
   * active filter asks for. Markers are already bounded to `1..pageCount`, so
   * the filtered lists never name a page the grid cannot render.
   */
  const pages = useMemo<readonly number[]>(() => {
    if (filter === 'problems') return markers.pageMarkers.problemPages;
    if (filter === 'annotated') return markers.pageMarkers.annotatedPages;
    return Array.from({ length: pageCount }, (_value, index) => index + 1);
  }, [filter, markers, pageCount]);

  // A document switch or an empty document invalidates the whole grid. These
  // effects run after the render that observes the change, which is why the
  // dialog also hides itself while `open` is still true but the document is
  // gone (see the early return below).
  const documentKey = `${documentEpoch}\u0000${filePath ?? ''}`;
  const documentChanged = documentKeyRef.current !== null && documentKeyRef.current !== documentKey;
  const gridKey = `${documentKey}\u0000${filter}`;

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

  /**
   * Opening (and every filter change) focuses the current page card, or the
   * first rendered card when the filter hides it. Focus that is already inside
   * the dialog — the filter button the user just pressed — is left alone.
   *
   * Deliberately *not* keyed on the rendered page list: an audit report or
   * annotation index arriving while the dialog is open produces a new list (and
   * new badges), but it must not steal focus or recenter the grid under the
   * user. The cards are read from the DOM when this runs, so `open`, `filter`,
   * `currentPage` and `pageCount` are the only events that need it.
   */
  useEffect(() => {
    if (!open || pageCount < 1) return;

    const filterChanged = filterRef.current !== filter;
    filterRef.current = filter;
    if (filterChanged) {
      const active = document.activeElement;
      if (
        active instanceof HTMLElement &&
        active.isConnected &&
        Boolean(dialogRef.current?.contains(active))
      ) {
        return;
      }
    }

    const containing =
      gridRef.current?.querySelector<HTMLElement>(`[data-page="${currentPage}"]`) ??
      gridRef.current?.querySelector<HTMLElement>('[data-page]');
    if (containing) {
      focusAndCenter(containing);
    } else {
      dialogRef.current?.focus();
    }
  }, [currentPage, filter, open, pageCount]);

  // Closing discards the visibility window (the cards unmount), so the next
  // open seeds around whatever page is current then. This reset lives outside
  // the observer effect on purpose: that effect must never clear a set the
  // observer has already grown.
  useEffect(() => {
    if (open) return;
    setVisiblePages((previous) => (previous.size === 0 ? previous : new Set()));
  }, [open]);

  // One observer per document/filter/grid. It only marks pages as visible; the
  // cards own the actual load. Environments without IntersectionObserver
  // (jsdom) fall back to "everything visible" so the dialog remains testable.
  useEffect(() => {
    if (!open || pageCount < 1) return;

    // A filter change replaces every card in the grid, so the previous window
    // no longer describes what is on screen: start from an empty set and seed
    // the new list (below) instead of keeping stale page numbers. The first run
    // has no previous window (the set is already empty), so it does not pay for
    // an extra render of a 1000-card grid.
    const previousGridKey = gridKeyRef.current;
    gridKeyRef.current = gridKey;
    if (previousGridKey !== null && previousGridKey !== gridKey) setVisiblePages(new Set());

    if (typeof IntersectionObserver === 'undefined') {
      setVisiblePages(new Set(pages));
      return;
    }

    // A 1000-card grid does not reliably deliver an initial intersecting batch
    // (the first paint can beat the observer), which left every card with a
    // skeleton until the user scrolled. Seed the viewport around the current
    // page ourselves and never overwrite a set the observer already grew.
    setVisiblePages((previous) => (previous.size > 0 ? previous : seedVisiblePages(pages, currentPage)));

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
  }, [currentPage, documentKey, filter, gridKey, open, pageCount, pages, pdfDocRef]);

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

      // Navigation walks the *rendered* list, so a filtered grid moves between
      // the pages it actually shows instead of jumping to a hidden page.
      const focusedPage = readPageNumber(document.activeElement) ?? currentPage;
      const index = pages.indexOf(focusedPage);
      let target: number | undefined;
      switch (event.key) {
        case 'ArrowRight':
          target = index < 0 ? undefined : pages[index + 1];
          break;
        case 'ArrowLeft':
          target = index < 0 ? undefined : pages[index - 1];
          break;
        case 'ArrowDown':
          target = index < 0 ? undefined : pages[index + readColumnCount()];
          break;
        case 'ArrowUp':
          target = index < 0 ? undefined : pages[index - readColumnCount()];
          break;
        case 'Home':
          target = pages[0];
          break;
        case 'End':
          target = pages[pages.length - 1];
          break;
        default:
          return;
      }
      if (target === undefined) return;

      event.preventDefault();
      const card = gridRef.current?.querySelector<HTMLElement>(`[data-page="${target}"]`);
      if (card) focusAndCenter(card);
    },
    [closeOverview, currentPage, focusableElements, pages, readColumnCount],
  );

  if (!open) return null;
  // The close effect above runs after this render; hiding immediately prevents
  // a frame of the new document's page count with the old grid.
  if (!filePath || pageCount < 1 || documentChanged) return null;

  const { pageMarkers, hasAuditReport, hasAnnotationIndex } = markers;
  const documentFindings = pageMarkers.documentFindings;
  const problemPageCount = pageMarkers.problemPages.length;
  const annotatedPageCount = pageMarkers.annotatedPages.length;

  /**
   * Page-level findings only.
   *
   * `markers.findings` is pages + document level, and the document-level count
   * has its own line (`Document-level: N`), so using the total here would count
   * those findings twice and inflate the per-severity numbers.
   */
  const pageFindings = {
    error: pageMarkers.findings.error - documentFindings.error,
    warning: pageMarkers.findings.warning - documentFindings.warning,
    info: pageMarkers.findings.info - documentFindings.info,
    total: pageMarkers.findings.total - documentFindings.total,
  };

  // Only markers of a report/index that belongs to this file are shown, so
  // another document's counts can never appear on these pages. Document-level
  // findings alone do not make a "Problems" line: they have their own one. A
  // ready index that found nothing gets no line either: "0 pages · 0 marks"
  // would only add noise to a dialog that is still just thumbnails.
  const showProblems = hasAuditReport && pageFindings.total > 0;
  const showDocument = hasAuditReport && documentFindings.total > 0;
  const showAnnotations =
    hasAnnotationIndex &&
    (pageMarkers.annotations > 0 || pageMarkers.annotationIssues > 0);
  const showMarkersHint = !hasAuditReport;

  // English needs "1 page" but "2 pages" (same for every count), so each count
  // in the summary is a pluralized phrase, never a bare number glued to a
  // literal noun.
  const problemsSummary = showProblems
    ? t('pageOverview.markers.problems', {
        pages: translatePlural(locale, 'pageOverview.markers.problemPages', problemPageCount),
        errors: translatePlural(locale, 'pageOverview.marker.error', pageFindings.error),
        warnings: translatePlural(locale, 'pageOverview.marker.warning', pageFindings.warning),
        info: translatePlural(locale, 'pageOverview.marker.info', pageFindings.info),
      })
    : null;

  const documentSummary = showDocument
    ? t('pageOverview.markers.document', { count: documentFindings.total })
    : null;

  const annotationsSummary = showAnnotations
    ? t('pageOverview.markers.annotations', {
        pages: translatePlural(locale, 'pageOverview.markers.annotationPages', annotatedPageCount),
        count: translatePlural(locale, 'pageOverview.markers.mark', pageMarkers.annotations),
        issues: translatePlural(locale, 'pageOverview.marker.issue', pageMarkers.annotationIssues),
      })
    : null;

  const emptyMessage =
    filter === 'problems'
      ? t('pageOverview.filter.empty.problems')
      : filter === 'annotated'
        ? t('pageOverview.filter.empty.annotated')
        : null;

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
        <div className={styles.summary} data-testid="page-overview-summary">
          {problemsSummary !== null && (
            <span
              className={`${styles.summaryLine} ${styles.summaryProblems}`}
              data-testid="page-overview-problems"
            >
              {problemsSummary}
            </span>
          )}
          {documentSummary !== null && (
            <span
              className={`${styles.summaryLine} ${styles.summaryDocument}`}
              data-testid="page-overview-document"
            >
              {documentSummary}
            </span>
          )}
          {annotationsSummary !== null && (
            <span
              className={`${styles.summaryLine} ${styles.summaryAnnotations}`}
              data-testid="page-overview-annotations"
            >
              {annotationsSummary}
            </span>
          )}
          {showMarkersHint && (
            <span
              className={`${styles.summaryLine} ${styles.summaryHint}`}
              data-testid="page-overview-markers-hint"
            >
              {t('pageOverview.markers.hint')}
            </span>
          )}
        </div>
        <div className={styles.filters}>
          <div
            className={styles.filterGroup}
            role="group"
            aria-label={t('pageOverview.filter.label')}
          >
            {FILTER_OPTIONS.map((option) => {
              // A filter with nothing to show is disabled rather than leading
              // to an empty grid the user cannot explain.
              const disabled =
                (option.value === 'problems' && problemPageCount === 0) ||
                (option.value === 'annotated' && annotatedPageCount === 0);
              const active = filter === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  className={`${styles.filterButton} ${active ? styles.filterButtonActive : ''}`}
                  aria-pressed={active}
                  disabled={disabled}
                  onClick={() => setFilter(option.value)}
                >
                  {t(option.labelKey)}
                </button>
              );
            })}
          </div>
          {filter !== 'all' && (
            <span className={styles.filterCount} data-testid="page-overview-filter-count">
              {t('pageOverview.filter.count', { filtered: pages.length, total: pageCount })}
            </span>
          )}
        </div>
        <div ref={scrollerRef} className={styles.scroller}>
          {pages.length === 0 ? (
            <p className={styles.empty} data-testid="page-overview-empty">
              {emptyMessage}
            </p>
          ) : (
            <div ref={gridRef} className={styles.grid} data-testid="page-overview-grid">
              {pages.map((page) => {
                const current = page === currentPage;
                const marker = pageMarkers.pages.get(page);
                return (
                  <button
                    key={`${documentKey}:${page}`}
                    type="button"
                    className={`${styles.card} ${current ? styles.cardCurrent : ''}`}
                    data-page={page}
                    aria-label={cardLabel(page, marker, locale, t)}
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
                      badges={marker ? <MarkerBadges marker={marker} locale={locale} /> : null}
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
          )}
        </div>
      </div>
    </div>
  );
};

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  DiffChange,
  DiffDocumentChange,
  DiffIgnoreRegion,
  DiffPage,
  DiffResult,
  DiffSide,
} from '../../../shared/diff-types';
import {
  translatePlural,
  useI18nStore,
  useT,
  type MessageKey,
  type TranslateFn,
} from '../../i18n';
import { ipc } from '../../services/ipc-client';
import { useElapsedSeconds } from '../../hooks/useElapsedSeconds';
import {
  DIFF_CHANGE_KINDS,
  DIFF_FILTER_TYPE_ORDER,
  buildDiffPageGroups,
  collectOverlayBoxes,
  collectPageBoxes,
  computeDiffFitZoom,
  countFilteredChanges,
  countPageResourceChanges,
  describeDiffDetails,
  describeDocumentChange,
  diffChangePreview,
  diffChangeTypeLabel,
  diffDocumentChangePreview,
  diffLinkTargetPage,
  diffPageLabel,
  diffPageStatusLabel,
  findResultPageIndexForPdfPage,
  firstInterestingPageIndex,
  formatDiffBBox,
  isDiffFilterActive,
  isDiffResultEmpty,
  matchesDocumentChangeFilter,
  pageGeometrySummary,
  resolveDiffPageJump,
  suggestDiffJsonFilename,
  tableCellChanges,
} from '../../services/diff-view';
import {
  formatPixelDiffStats,
  VISUAL_DIFF_STYLES,
  type PixelDiffStats,
  type VisualDiffStyle,
} from '../../services/visual-diff';
import { selectDiffPage, useDiffStore } from '../../store/diff-store';
import { DiffPdfPane } from './DiffPdfPane';
import { DiffVisualPane } from './DiffVisualPane';
import styles from './DiffWorkspace.module.css';

/** Gap between the two side-by-side panes (see the module CSS). */
const PANE_GAP = 8;

/** Zoom step of the workspace's −/+ buttons, matching the Inspect toolbar. */
const ZOOM_STEP = 0.25;

/** Message keys of the visual style buttons. */
const VISUAL_STYLE_KEYS: Record<VisualDiffStyle, MessageKey> = {
  blend: 'diff.visualStyle.blend',
  heatmap: 'diff.visualStyle.heatmap',
  boxes: 'diff.visualStyle.boxes',
};

/**
 * Side/page label of one ignore region: a paired region masks both pages, a
 * one-sided region only the page that exists.
 */
export function describeIgnoreRegion(region: DiffIgnoreRegion, t: TranslateFn): string {
  const side =
    region.oldPage !== null && region.newPage !== null
      ? t('diff.region.side.both')
      : region.newPage !== null
        ? t('diff.region.side.new')
        : t('diff.region.side.old');
  const pages =
    region.oldPage !== null && region.newPage !== null
      ? region.oldPage === region.newPage
        ? t('diff.region.page', { page: region.oldPage })
        : t('diff.region.pagePair', { old: region.oldPage, new: region.newPage })
      : region.newPage !== null
        ? t('diff.region.page', { page: region.newPage })
        : t('diff.region.page', { page: region.oldPage ?? '—' });
  return `${side} · ${pages}`;
}

const changePages = (change: DiffChange, t: TranslateFn): string => {
  if (change.oldPage !== null && change.newPage !== null) {
    return change.oldPage === change.newPage
      ? t('diff.page.same', { page: change.oldPage })
      : t('diff.page.pair', { old: change.oldPage, new: change.newPage });
  }
  if (change.newPage !== null) return t('diff.change.pageAdded', { page: change.newPage });
  if (change.oldPage !== null) return t('diff.change.pageRemoved', { page: change.oldPage });
  return '—';
};

const Summary: React.FC<{ result: DiffResult }> = ({ result }) => {
  const t = useT();
  const { summary } = result;
  const items: Array<[MessageKey, string]> = [
    ['diff.summary.pages', `${result.old.pages} → ${result.new.pages}`],
    ['diff.summary.changedPages', String(summary.pagesChanged)],
    ['diff.summary.pagesAdded', String(summary.pagesAdded)],
    ['diff.summary.pagesRemoved', String(summary.pagesRemoved)],
    ['diff.summary.objectsAdded', String(summary.objectsAdded)],
    ['diff.summary.objectsRemoved', String(summary.objectsRemoved)],
    ['diff.summary.objectsMoved', String(summary.objectsMoved)],
    ['diff.summary.objectsModified', String(summary.objectsModified)],
  ];

  // Resource counters come from the reported changes, so a resource type with
  // nothing to show keeps the summary compact. Document changes are metadata and
  // page labels: they never count as page objects.
  const resources = countPageResourceChanges(result.pages);
  if (resources.annotation > 0) {
    items.push(['diff.summary.annotations', String(resources.annotation)]);
  }
  if (resources.link > 0) items.push(['diff.summary.links', String(resources.link)]);
  if (resources.form > 0) items.push(['diff.summary.forms', String(resources.form)]);

  const documentChanges = result.documentChanges?.length ?? summary.documentChanges ?? 0;
  if (documentChanges > 0) {
    items.push(['diff.summary.documentChanges', String(documentChanges)]);
  }

  return (
    <dl className={styles.summaryGrid} aria-label={t('diff.summary.label')} data-testid="diff-summary">
      {items.map(([labelKey, value]) => (
        <div key={labelKey} className={styles.summaryItem}>
          <dt className={styles.summaryLabel}>{t(labelKey)}</dt>
          <dd className={styles.summaryValue}>{value}</dd>
        </div>
      ))}
    </dl>
  );
};

const ChangeDetails: React.FC<{
  change: DiffChange;
  pages: DiffPage[];
  onGoToPage: (pageIndex: number) => void;
}> = ({ change, pages, onGoToPage }) => {
  const t = useT();
  const detailRows = describeDiffDetails(change, t);
  const cellChanges = tableCellChanges(change);
  const geometry = pageGeometrySummary(change, t);
  const hasText = Boolean(change.textOld) || Boolean(change.textNew);
  // Only an internal link target has a page to jump to; an external URI stays
  // text in the details table and is never opened.
  const targetPage = diffLinkTargetPage(change);
  const targetPageIndex =
    targetPage === null ? null : findResultPageIndexForPdfPage(pages, targetPage);

  return (
    <div className={styles.detailBody} data-testid="diff-change-details">
      <h3 className={styles.detailTitle}>
        <span className={styles.kindBadge} data-kind={change.kind}>
          {change.kind}
        </span>
        <span className={styles.detailType}>{diffChangeTypeLabel(change.type, t)}</span>
      </h3>

      <dl className={styles.detailList}>
        <div className={styles.detailRow}>
          <dt>{t('diff.detail.page')}</dt>
          <dd>{changePages(change, t)}</dd>
        </div>
        <div className={styles.detailRow}>
          <dt>{t('diff.detail.oldBox')}</dt>
          <dd>{formatDiffBBox(change.oldBBox)}</dd>
        </div>
        <div className={styles.detailRow}>
          <dt>{t('diff.detail.newBox')}</dt>
          <dd>{formatDiffBBox(change.newBBox)}</dd>
        </div>
      </dl>

      {geometry.length > 0 && (
        <div className={styles.geometryNote} role="note">
          {geometry.map((line) => (
            <p key={line}>{line}</p>
          ))}
          <p className={styles.geometryHint}>{t('diff.detail.geometryHint')}</p>
        </div>
      )}

      {hasText && (
        <div className={styles.textBlock}>
          <div>
            <span className={styles.textLabel}>{t('diff.side.old')}</span>
            <pre className={styles.pre}>{change.textOld ?? '—'}</pre>
          </div>
          <div>
            <span className={styles.textLabel}>{t('diff.side.new')}</span>
            <pre className={styles.pre}>{change.textNew ?? '—'}</pre>
          </div>
        </div>
      )}

      {detailRows.length > 0 && (
        <table className={styles.detailTable}>
          <thead>
            <tr>
              <th scope="col">{t('diff.detail.column')}</th>
              <th scope="col">{t('diff.side.old')}</th>
              <th scope="col">{t('diff.side.new')}</th>
            </tr>
          </thead>
          <tbody>
            {detailRows.map((row) => (
              <tr key={row.label}>
                <th scope="row">{row.label}</th>
                <td>{row.oldValue}</td>
                <td>{row.newValue}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {targetPage !== null && (
        <div>
          <button
            className={styles.linkButton}
            type="button"
            title={t('diff.page.same', { page: targetPage })}
            onClick={() => {
              if (targetPageIndex !== null) onGoToPage(targetPageIndex);
            }}
            disabled={targetPageIndex === null}
          >
            {t('diff.documentChanges.goToPage')}
          </button>
        </div>
      )}

      {cellChanges.length > 0 && (
        <table className={styles.detailTable} data-testid="diff-cell-changes">
          <caption className={styles.tableCaption}>{t('diff.detail.tableCells')}</caption>
          <thead>
            <tr>
              <th scope="col">{t('diff.detail.cell')}</th>
              <th scope="col">{t('diff.side.old')}</th>
              <th scope="col">{t('diff.side.new')}</th>
            </tr>
          </thead>
          <tbody>
            {cellChanges.map((cell) => (
              <tr key={`${cell.row}:${cell.col}`}>
                <th scope="row">
                  r{cell.row} c{cell.col}
                </th>
                <td>{cell.old === '' ? '—' : cell.old}</td>
                <td>{cell.new === '' ? '—' : cell.new}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {!hasText && detailRows.length === 0 && cellChanges.length === 0 && geometry.length === 0 && (
        <p className={styles.hint}>{t('diff.detail.none')}</p>
      )}
    </div>
  );
};

/**
 * Details of a document change (metadata field or page label).
 *
 * There is no bbox and no page object to show: the value rows are the content.
 * A page label also offers "Go to page", which is the only navigation from this
 * panel; metadata has no page and therefore no jump button.
 */
const DocumentChangeDetails: React.FC<{
  change: DiffDocumentChange;
  pages: DiffPage[];
  onGoToPage: (pageIndex: number) => void;
}> = ({ change, pages, onGoToPage }) => {
  const t = useT();
  const rows = describeDocumentChange(change, t);
  const targetPageIndex =
    change.page === null ? null : findResultPageIndexForPdfPage(pages, change.page);

  return (
    <div className={styles.detailBody} data-testid="diff-document-details">
      <h3 className={styles.detailTitle}>
        <span className={styles.kindBadge} data-kind={change.kind}>
          {change.kind}
        </span>
        <span className={styles.detailType}>{diffChangeTypeLabel(change.type, t)}</span>
      </h3>

      {change.page !== null && (
        <dl className={styles.detailList}>
          <div className={styles.detailRow}>
            <dt>{t('diff.detail.page')}</dt>
            <dd>{t('diff.page.same', { page: change.page })}</dd>
          </div>
        </dl>
      )}

      <table className={styles.detailTable}>
        <thead>
          <tr>
            <th scope="col">{t('diff.detail.column')}</th>
            <th scope="col">{t('diff.side.old')}</th>
            <th scope="col">{t('diff.side.new')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={`${row.label}:${index}`}>
              <th scope="row">{row.label}</th>
              <td>{row.oldValue}</td>
              <td>{row.newValue}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {change.page !== null && (
        <div>
          <button
            className={styles.linkButton}
            type="button"
            onClick={() => {
              if (targetPageIndex !== null) onGoToPage(targetPageIndex);
            }}
            disabled={targetPageIndex === null}
          >
            {t('diff.documentChanges.goToPage')}
          </button>
        </div>
      )}
    </div>
  );
};

/**
 * The Diff workspace: summary + change list, two synced PDF panes (or one
 * overlay pane) and the details of the selected change.
 *
 * All navigation state lives in `diff-store`; the component only reads it, so
 * switching pages, zoom or view mode never touches the Inspect document.
 */
export const DiffWorkspace: React.FC = () => {
  const t = useT();
  const locale = useI18nStore((s) => s.locale);
  const result = useDiffStore((s) => s.result);
  const loading = useDiffStore((s) => s.loading);
  const error = useDiffStore((s) => s.error);
  const filter = useDiffStore((s) => s.filter);
  const viewMode = useDiffStore((s) => s.viewMode);
  const zoom = useDiffStore((s) => s.zoom);
  const visualOpacity = useDiffStore((s) => s.visualOpacity);
  const visualStyle = useDiffStore((s) => s.visualStyle);
  const regionMode = useDiffStore((s) => s.regionMode);
  const ignoreRegions = useDiffStore((s) => s.options.ignoreRegions);
  const pageIndex = useDiffStore((s) => s.pageIndex);
  const selection = useDiffStore((s) => s.selection);
  const documentSelection = useDiffStore((s) => s.documentSelection);
  const oldSource = useDiffStore((s) => s.oldSource);
  const newSource = useDiffStore((s) => s.newSource);
  const oldName = useDiffStore((s) => s.oldName);
  const newName = useDiffStore((s) => s.newName);

  const setFilter = useDiffStore((s) => s.setFilter);
  const resetFilter = useDiffStore((s) => s.resetFilter);
  const setViewMode = useDiffStore((s) => s.setViewMode);
  const setZoom = useDiffStore((s) => s.setZoom);
  const setVisualOpacity = useDiffStore((s) => s.setVisualOpacity);
  const setVisualStyle = useDiffStore((s) => s.setVisualStyle);
  const setRegionMode = useDiffStore((s) => s.setRegionMode);
  const addIgnoreRegion = useDiffStore((s) => s.addIgnoreRegion);
  const removeIgnoreRegion = useDiffStore((s) => s.removeIgnoreRegion);
  const clearIgnoreRegions = useDiffStore((s) => s.clearIgnoreRegions);
  const setPageIndex = useDiffStore((s) => s.setPageIndex);
  const stepPage = useDiffStore((s) => s.stepPage);
  const selectChangeAt = useDiffStore((s) => s.selectChangeAt);
  const selectChange = useDiffStore((s) => s.selectChange);
  const selectDocumentChange = useDiffStore((s) => s.selectDocumentChange);
  const openSetup = useDiffStore((s) => s.openSetup);
  const exitWorkspace = useDiffStore((s) => s.exitWorkspace);

  const [centerEl, setCenterEl] = useState<HTMLDivElement | null>(null);
  const [centerWidth, setCenterWidth] = useState(0);
  const [pixelStats, setPixelStats] = useState<PixelDiffStats | null>(null);
  /** Result-page indexes the user has open; every other group is folded. */
  const [expandedPages, setExpandedPages] = useState<ReadonlySet<number>>(
    // Seeded from the result already applied at mount so the list never flashes
    // fully folded before the reset effect below runs.
    () => new Set(result ? [firstInterestingPageIndex(result.pages)] : []),
  );
  /** Document changes are one small group above the pages: open by default. */
  const [documentExpanded, setDocumentExpanded] = useState(true);
  /** Raw text of the "Go to page" field; only digits are acted on. */
  const [pageJump, setPageJump] = useState('');
  const fittedResultRef = useRef<DiffResult | null>(null);
  // Informational only: exact seconds spent comparing, no invented percentage.
  // Resets whenever `loading` turns off (a new run starts again at 0s).
  const elapsedSeconds = useElapsedSeconds(loading);

  const pages = result?.pages ?? [];
  const totalPages = pages.length;
  const page = result?.pages[pageIndex] ?? null;
  const groups = useMemo(() => buildDiffPageGroups(pages, filter), [pages, filter]);
  const filteredCount = useMemo(() => countFilteredChanges(pages, filter), [pages, filter]);
  /**
   * Filtered document changes with their raw `result.documentChanges` index, so
   * a selection keeps pointing at the same row while the type filter changes.
   * The kind filter never applies: metadata/page labels have no page object.
   */
  const filteredDocumentChanges = useMemo(
    () =>
      (result?.documentChanges ?? []).reduce<Array<{ change: DiffDocumentChange; index: number }>>(
        (entries, change, index) => {
          if (matchesDocumentChangeFilter(change, filter)) entries.push({ change, index });
          return entries;
        },
        [],
      ),
    [filter, result],
  );
  const filteredDocumentCount = filteredDocumentChanges.length;
  const documentListVisible = documentExpanded && filteredDocumentCount > 0;
  const hasDocumentChanges = (result?.documentChanges?.length ?? 0) > 0;
  const selectedChange = useMemo(() => {
    if (!result || !selection) return null;
    return result.pages[selection.pageIndex]?.changes[selection.changeIndex] ?? null;
  }, [result, selection]);
  // Derive the document change here rather than through a selector that builds
  // an object: a fresh object on every store read would re-render forever.
  const selectedDocumentChange = useMemo(() => {
    if (!result || documentSelection === null) return null;
    const change = result.documentChanges?.[documentSelection];
    return change ? { index: documentSelection, change } : null;
  }, [documentSelection, result]);

  const oldBoxes = useMemo(
    () => (page ? collectPageBoxes(page, 'old', selection, pageIndex) : []),
    [page, pageIndex, selection],
  );
  const newBoxes = useMemo(
    () => (page ? collectPageBoxes(page, 'new', selection, pageIndex) : []),
    [page, pageIndex, selection],
  );
  const overlayBoxes = useMemo(
    () => (page ? collectOverlayBoxes(page, selection, pageIndex) : []),
    [page, pageIndex, selection],
  );

  // Pixel stats belong to one rendered page pair: a new page or result must not
  // keep the previous numbers on screen while the visual pane re-renders.
  useEffect(() => {
    setPixelStats(null);
  }, [pageIndex, result]);

  const handleRenderStats = useCallback((stats: PixelDiffStats | null) => {
    setPixelStats(stats);
  }, []);

  // -- left pane: foldable page groups -------------------------------------
  //
  // A comparison can list hundreds of pages, so the list opens folded to the
  // page the diff focused. Expansion is a set of result-page indexes (never PDF
  // page numbers): it survives filter changes and navigation, and only a new
  // result resets it.
  useEffect(() => {
    if (!result) {
      setExpandedPages(new Set());
      setDocumentExpanded(true);
      return;
    }
    setExpandedPages(new Set([firstInterestingPageIndex(result.pages)]));
    // A new result starts with its document changes visible: they are few and
    // easily missed if the only fold control is at the top of the page list.
    setDocumentExpanded(true);
  }, [result]);

  // Filtering down to metadata/page labels is a request to inspect document
  // changes, so their group must not stay folded.
  useEffect(() => {
    if (filter.type === 'metadata' || filter.type === 'page-label') {
      setDocumentExpanded(true);
    }
  }, [filter.type]);

  // Prev/Next, the page jump and a change selection all move the current page.
  // Its group must be open, or the row the panes are showing would be hidden.
  useEffect(() => {
    if (!result) return;
    setExpandedPages((previous) =>
      previous.has(pageIndex) ? previous : new Set(previous).add(pageIndex),
    );
  }, [pageIndex, result]);

  // Filtering is a request to see matches, so open the groups that contain
  // some. This only ever adds: groups the user opened stay open.
  useEffect(() => {
    if (!result || !isDiffFilterActive(filter)) return;

    const matching = buildDiffPageGroups(result.pages, filter).map((group) => group.pageIndex);
    if (matching.length === 0) return;

    setExpandedPages((previous) => {
      if (matching.every((index) => previous.has(index))) return previous;
      const next = new Set(previous);
      for (const index of matching) next.add(index);
      return next;
    });
  }, [filter, result]);

  const togglePageGroup = useCallback((index: number) => {
    setExpandedPages((previous) => {
      const next = new Set(previous);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }, []);

  const expandAllGroups = useCallback(() => {
    setExpandedPages(new Set(groups.map((group) => group.pageIndex)));
  }, [groups]);

  const collapseAllGroups = useCallback(() => setExpandedPages(new Set()), []);

  const goToPage = useCallback(() => {
    const index = resolveDiffPageJump(pageJump, totalPages);
    if (index === null) return;
    setPageIndex(index);
  }, [pageJump, setPageIndex, totalPages]);

  // Measure the center column so "Fit" reflects the real pane width instead of
  // a window-width guess (panels and the summary column take space away).
  useEffect(() => {
    if (!centerEl) {
      setCenterWidth(0);
      return;
    }

    const measure = (): void => {
      const width = centerEl.clientWidth;
      setCenterWidth(Number.isFinite(width) && width > 0 ? width : 0);
    };

    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }

    const observer = new ResizeObserver(measure);
    observer.observe(centerEl);
    return () => observer.disconnect();
  }, [centerEl]);

  const fitToWidth = useCallback(() => {
    const state = useDiffStore.getState();
    const current = selectDiffPage(state);
    if (!current || centerWidth <= 0) return;

    const widths = [current.oldSize?.width ?? 0, current.newSize?.width ?? 0];
    const paneWidth = state.viewMode === 'side-by-side' ? (centerWidth - PANE_GAP) / 2 : centerWidth;
    state.setZoom(computeDiffFitZoom(paneWidth, state.viewMode === 'side-by-side' ? widths : [Math.max(...widths)]));
  }, [centerWidth]);

  // Fit once per newly applied result, the same way the Inspect viewport does.
  useEffect(() => {
    if (!result || centerWidth <= 0) return;
    if (fittedResultRef.current === result) return;
    fittedResultRef.current = result;
    fitToWidth();
  }, [centerWidth, fitToWidth, result]);

  const handleExportJson = useCallback(async () => {
    const state = useDiffStore.getState();
    if (!state.result) return;

    try {
      const response = await ipc.saveFile({
        defaultPath: suggestDiffJsonFilename(state.oldName, state.newName),
        content: JSON.stringify(state.result, null, 2),
        filterName: 'JSON',
        extensions: ['json'],
      });
      if (response.canceled) return;
      if (response.error) {
        useDiffStore.getState().setError(t('export.failedDetail', { error: response.error }));
      }
    } catch (err) {
      useDiffStore.getState().setError(
        err instanceof Error
          ? t('export.failedDetail', { error: err.message })
          : t('export.failed'),
      );
    }
  }, [t]);

  /**
   * Re-run the comparison with the drawn regions.
   *
   * Explicit on purpose: drawing a rectangle only edits the region list, so a
   * drag never fires a diff per mouse move. `diffPdfs` receives the current
   * sources and options, exactly like the setup dialog does.
   */
  const handleApplyRegions = useCallback(async () => {
    const state = useDiffStore.getState();
    if (state.loading) return;
    if (!state.oldSource || !state.newSource) {
      state.setError(t('diff.region.chooseBoth'));
      return;
    }

    state.setError(null);
    state.setLoading(true);
    try {
      const next = await ipc.diffPdfs(state.oldSource, state.newSource, state.options);
      // `applyResult` clears the loading flag, the previous error and the
      // stale selection/page focus.
      useDiffStore.getState().applyResult(next);
    } catch (err) {
      const store = useDiffStore.getState();
      store.setLoading(false);
      store.setError(err instanceof Error ? err.message : t('diff.setup.diffFailed'));
    }
  }, [t]);

  // Metadata-only edits leave every page unchanged, but the documents are not
  // identical: the empty state must only claim that when no document change
  // exists either.
  const empty = result ? isDiffResultEmpty(pages) && !hasDocumentChanges : false;
  // Overlay draws exactly one page, so it must be the side that owns it. An
  // added page has no old side: loading the old document at the new page number
  // would show an unrelated page (or none), so the new source, number and size
  // win whenever `oldIndex` is null — and vice versa for a removed page.
  const overlaySide: DiffSide = page && page.oldIndex === null ? 'new' : 'old';
  const overlayBaseSource = overlaySide === 'old' ? oldSource : newSource;
  const overlayPageNumber = page
    ? overlaySide === 'old'
      ? page.oldIndex
      : page.newIndex
    : null;
  const overlayPageSize = page
    ? overlaySide === 'old'
      ? page.oldSize
      : page.newSize
    : null;

  return (
    <section
      className={styles.workspace}
      aria-label={t('diff.workspace.aria')}
      data-testid="diff-workspace"
    >
      <header className={styles.toolbar}>
        <button className={styles.button} type="button" onClick={exitWorkspace}>
          {t('workspace.backToInspect')}
        </button>
        <span className={styles.separator} />
        <span className={styles.title}>{t('diff.workspace.title')}</span>
        <span
          className={styles.names}
          title={`${oldName ?? '—'} → ${newName ?? '—'}`}
          data-testid="diff-names"
        >
          {oldName ?? '—'} → {newName ?? '—'}
        </span>

        <span className={styles.spacer} />

        <div className={styles.group} role="group" aria-label={t('diff.workspace.viewModeGroup')}>
          <button
            className={`${styles.button} ${viewMode === 'side-by-side' ? styles.active : ''}`}
            type="button"
            aria-pressed={viewMode === 'side-by-side'}
            onClick={() => setViewMode('side-by-side')}
          >
            {t('diff.workspace.sideBySide')}
          </button>
          <button
            className={`${styles.button} ${viewMode === 'overlay' ? styles.active : ''}`}
            type="button"
            aria-pressed={viewMode === 'overlay'}
            onClick={() => setViewMode('overlay')}
            title={t('diff.workspace.overlayTitle')}
          >
            {t('diff.workspace.overlay')}
          </button>
          <button
            className={`${styles.button} ${viewMode === 'visual' ? styles.active : ''}`}
            type="button"
            aria-pressed={viewMode === 'visual'}
            onClick={() => setViewMode('visual')}
            title={t('diff.workspace.visualTitle')}
          >
            {t('diff.workspace.visual')}
          </button>
        </div>

        {viewMode === 'visual' && (
          <>
            <span className={styles.separator} />

            <div
              className={styles.group}
              role="group"
              aria-label={t('diff.workspace.visualStyleGroup')}
            >
              {VISUAL_DIFF_STYLES.map((style) => (
                <button
                  key={style}
                  className={`${styles.button} ${visualStyle === style ? styles.active : ''}`}
                  type="button"
                  aria-pressed={visualStyle === style}
                  onClick={() => setVisualStyle(style)}
                >
                  {t(VISUAL_STYLE_KEYS[style])}
                </button>
              ))}
            </div>

            <div className={styles.group}>
              <label className={styles.sliderLabel}>
                {t('diff.workspace.oldPage')}
                <input
                  className={styles.slider}
                  type="range"
                  min={0}
                  max={100}
                  step={5}
                  aria-label={t('diff.workspace.oldPageOpacity')}
                  aria-valuetext={`${Math.round(visualOpacity * 100)}%`}
                  value={Math.round(visualOpacity * 100)}
                  onChange={(event) => setVisualOpacity(Number(event.target.value) / 100)}
                />
                <span className={styles.value}>{Math.round(visualOpacity * 100)}%</span>
              </label>
            </div>
          </>
        )}

        <span className={styles.separator} />

        <div className={styles.group}>
          <button
            className={`${styles.button} ${regionMode ? styles.active : ''}`}
            type="button"
            aria-pressed={regionMode}
            onClick={() => setRegionMode(!regionMode)}
            disabled={!page}
            title={t('diff.workspace.ignoreRegionTitle')}
          >
            {t('diff.workspace.ignoreRegion')}
          </button>
        </div>

        <span className={styles.separator} />

        <div className={styles.group} role="group" aria-label={t('diff.workspace.zoomGroup')}>
          <button
            className={styles.button}
            type="button"
            onClick={() => setZoom(zoom - ZOOM_STEP)}
            disabled={zoom <= 0.25}
            aria-label={t('diff.workspace.zoomOut')}
          >
            −
          </button>
          <span className={styles.value}>{Math.round(zoom * 100)}%</span>
          <button
            className={styles.button}
            type="button"
            onClick={() => setZoom(zoom + ZOOM_STEP)}
            disabled={zoom >= 5}
            aria-label={t('diff.workspace.zoomIn')}
          >
            +
          </button>
          <button
            className={styles.button}
            type="button"
            onClick={fitToWidth}
            disabled={!page || centerWidth <= 0}
            title={t('diff.workspace.fitTitle')}
          >
            {t('diff.workspace.fit')}
          </button>
        </div>

        <span className={styles.separator} />

        <div
          className={styles.group}
          role="group"
          aria-label={t('diff.workspace.pageNavigation')}
        >
          <button
            className={styles.button}
            type="button"
            onClick={() => stepPage(-1)}
            disabled={!result || pageIndex <= 0}
          >
            {t('toolbar.prev')}
          </button>
          <span className={styles.value}>
            {totalPages > 0 ? `${pageIndex + 1} / ${totalPages}` : '—'}
          </span>
          <button
            className={styles.button}
            type="button"
            onClick={() => stepPage(1)}
            disabled={!result || pageIndex >= totalPages - 1}
          >
            {t('toolbar.next')}
          </button>
        </div>

        <span className={styles.separator} />

        <div className={styles.group}>
          <button className={styles.button} type="button" onClick={openSetup}>
            {t('diff.workspace.changeFiles')}
          </button>
          <button
            className={styles.button}
            type="button"
            onClick={() => void handleExportJson()}
            disabled={!result}
            title={t('diff.workspace.exportJsonTitle')}
          >
            {t('common.exportJson')}
          </button>
        </div>
      </header>

      <div className={styles.body}>
        <aside className={styles.summaryPane} aria-label={t('diff.workspace.changeList')}>
          {result && <Summary result={result} />}

          <div className={styles.filters}>
            <label className={styles.filterLabel}>
              {t('diff.filter.kind')}
              <select
                className={styles.select}
                aria-label={t('diff.filter.kindTitle')}
                value={filter.kind}
                onChange={(event) =>
                  setFilter({ kind: event.target.value as typeof filter.kind })
                }
              >
                <option value="all">{t('diff.filter.allKinds')}</option>
                {DIFF_CHANGE_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {kind}
                  </option>
                ))}
              </select>
            </label>
            <label className={styles.filterLabel}>
              {t('diff.filter.type')}
              <select
                className={styles.select}
                aria-label={t('diff.filter.typeTitle')}
                value={filter.type}
                onChange={(event) =>
                  setFilter({ type: event.target.value as typeof filter.type })
                }
              >
                <option value="all">{t('diff.filter.allTypes')}</option>
                {DIFF_FILTER_TYPE_ORDER.map((type) => (
                  <option key={type} value={type}>
                    {diffChangeTypeLabel(type, t)}
                  </option>
                ))}
              </select>
            </label>
            <button
              className={styles.linkButton}
              type="button"
              onClick={resetFilter}
              disabled={filter.kind === 'all' && filter.type === 'all'}
            >
              {t('common.reset')}
            </button>
          </div>

          {result && (
            <section
              className={styles.regionPanel}
              aria-label={t('diff.region.panelLabel')}
              data-testid="diff-region-panel"
            >
              <div className={styles.regionHeader}>
                <span className={styles.regionTitle}>{t('diff.region.panelLabel')}</span>
                <span className={styles.regionCount} data-testid="diff-region-count">
                  {ignoreRegions.length}
                </span>
              </div>

              {ignoreRegions.length === 0 ? (
                <p className={styles.regionHint}>
                  {regionMode ? t('diff.region.hintDraw') : t('diff.region.hintEnable')}
                </p>
              ) : (
                <ul className={styles.regionList} data-testid="diff-region-list">
                  {ignoreRegions.map((region, index) => (
                    <li
                      key={`${index}:${region.oldPage}:${region.newPage}:${region.bbox.x0}:${region.bbox.y0}`}
                      className={styles.regionItem}
                    >
                      <span className={styles.regionText}>
                        <span className={styles.regionPages}>
                          {describeIgnoreRegion(region, t)}
                        </span>
                        <span className={styles.regionBox}>{formatDiffBBox(region.bbox)}</span>
                      </span>
                      <button
                        className={styles.linkButton}
                        type="button"
                        onClick={() => removeIgnoreRegion(index)}
                        aria-label={t('diff.region.removeAria', { index: index + 1 })}
                      >
                        {t('diff.region.remove')}
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              <div className={styles.regionActions}>
                <button
                  className={styles.button}
                  type="button"
                  onClick={() => void handleApplyRegions()}
                  disabled={loading || ignoreRegions.length === 0 || !oldSource || !newSource}
                  title={t('diff.region.applyTitle')}
                >
                  {loading ? t('diff.region.applying') : t('diff.region.apply')}
                </button>
                <button
                  className={styles.linkButton}
                  type="button"
                  onClick={clearIgnoreRegions}
                  disabled={ignoreRegions.length === 0}
                >
                  {t('diff.region.clear')}
                </button>
              </div>

              {regionMode && viewMode === 'visual' && (
                <p className={styles.regionHint}>{t('diff.region.visualHint')}</p>
              )}
            </section>
          )}

          {!result && !loading && (
            <p className={styles.hint}>{t('diff.workspace.noComparison')}</p>
          )}

          {loading && <p className={styles.hint}>{t('diff.workspace.comparing')}</p>}

          {result && empty && (
            <p className={styles.emptyState} role="status">
              {t('diff.workspace.identical')}
            </p>
          )}

          {result && !empty && filteredCount === 0 && filteredDocumentCount === 0 && (
            <p className={styles.emptyState} role="status">
              {isDiffFilterActive(filter)
                ? t('diff.workspace.noFilterMatch')
                : t('diff.workspace.noObjectChanges')}
            </p>
          )}

          {result && filteredCount > 0 && (
            <p className={styles.listCount}>
              {translatePlural(locale, 'diff.workspace.changeCount', filteredCount)}
            </p>
          )}

          {/*
            The engine stops at its MAX_DIFF_CHANGES safety cap. Say so once:
            a truncated list must never look like a complete comparison.
          */}
          {result?.summary.changesTruncated && (
            <p className={styles.truncatedNote} role="status" data-testid="diff-truncated">
              {t('diff.workspace.truncated')}
            </p>
          )}

          {/*
            Jump + fold controls sit directly above the list. The row must stay
            usable in a 200px sidebar, so it is a compact input/button pair and
            the position, with the label only for assistive technology.
          */}
          <div className={styles.pageJump}>
            <label className={styles.visuallyHidden} htmlFor="diff-page-jump">
              {t('diff.workspace.goToPage')}
            </label>
            <input
              id="diff-page-jump"
              className={styles.pageJumpInput}
              type="number"
              inputMode="numeric"
              min={1}
              max={totalPages > 0 ? totalPages : undefined}
              placeholder={
                totalPages > 0 ? t('diff.workspace.pageJumpPlaceholder', { count: totalPages }) : '—'
              }
              value={pageJump}
              onChange={(event) => setPageJump(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return;
                event.preventDefault();
                goToPage();
              }}
              disabled={!result || totalPages === 0}
              aria-label={t('diff.workspace.goToPage')}
              title={t('diff.workspace.pageJumpTitle')}
            />
            <button
              className={styles.button}
              type="button"
              onClick={goToPage}
              disabled={!result || totalPages === 0}
              title={t('diff.workspace.pageJumpButtonTitle')}
            >
              {t('diff.workspace.go')}
            </button>
            <span className={styles.pageJumpStatus} data-testid="diff-page-jump-status">
              {totalPages > 0
                ? t('diff.workspace.pageOf', { page: pageIndex + 1, count: totalPages })
                : '—'}
            </span>
          </div>

          <div className={styles.listActions}>
            <button
              className={styles.linkButton}
              type="button"
              onClick={expandAllGroups}
              disabled={groups.length === 0}
            >
              {t('diff.workspace.expandAll')}
            </button>
            <button
              className={styles.linkButton}
              type="button"
              onClick={collapseAllGroups}
              disabled={groups.length === 0}
            >
              {t('diff.workspace.collapseAll')}
            </button>
          </div>

          {/*
            Document changes (metadata and page labels) sit above the page
            groups: they are document-scoped, so they are not nested under a
            page. The type filter applies; the page kind filter does not.
          */}
          {result && hasDocumentChanges && (
            <section
              className={styles.documentChanges}
              aria-label={t('diff.documentChanges.title')}
              data-testid="diff-document-changes"
            >
              <button
                className={styles.documentHeader}
                type="button"
                aria-expanded={documentExpanded}
                aria-controls={documentListVisible ? 'diff-document-change-list' : undefined}
                onClick={() => setDocumentExpanded((expanded) => !expanded)}
              >
                <span
                  className={styles.chevron}
                  data-expanded={documentExpanded}
                  aria-hidden="true"
                >
                  ▸
                </span>
                <span className={styles.documentTitle}>{t('diff.documentChanges.title')}</span>
                <span className={styles.pageCount} data-testid="diff-document-change-count">
                  {filteredDocumentCount}
                </span>
              </button>

              {documentExpanded && filteredDocumentCount === 0 && (
                <p className={styles.documentEmpty}>{t('diff.documentChanges.empty')}</p>
              )}

              {documentListVisible && (
                <ul className={styles.documentList} id="diff-document-change-list">
                  {filteredDocumentChanges.map(({ change, index }) => {
                    const typeLabel = diffChangeTypeLabel(change.type, t);
                    const preview = diffDocumentChangePreview(change, t);
                    const isSelected = documentSelection === index;
                    return (
                      <li key={`${change.type}:${change.page ?? 'doc'}:${change.field}:${index}`}>
                        <button
                          className={`${styles.changeItem} ${styles.documentItem} ${
                            isSelected ? styles.changeItemSelected : ''
                          }`}
                          type="button"
                          aria-pressed={isSelected}
                          aria-label={`${change.kind} ${typeLabel}: ${preview}`}
                          onClick={() => selectDocumentChange(index)}
                        >
                          <span className={styles.kindBadge} data-kind={change.kind}>
                            {change.kind}
                          </span>
                          <span className={styles.changeType}>{typeLabel}</span>
                          <span className={styles.documentMain}>
                            <span className={styles.changePreview} title={preview}>
                              {preview}
                            </span>
                            {/* Field names are schema values (title, author, page-label). */}
                            <span className={styles.documentField} title={change.field}>
                              {change.field}
                            </span>
                          </span>
                          {change.page !== null && (
                            <span
                              className={styles.documentPage}
                              title={t('diff.page.same', { page: change.page })}
                            >
                              #{change.page}
                            </span>
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          )}

          <ul className={styles.pageList} data-testid="diff-page-list">
            {groups.map((group) => {
              const expanded = expandedPages.has(group.pageIndex);
              const hasChanges = group.changes.length > 0;
              const changesId = `diff-page-changes-${group.pageIndex}`;

              return (
                <li key={group.pageIndex} className={styles.pageGroup}>
                  {/*
                    One button per page: it selects the page and folds its
                    changes, so the whole row is the disclosure control (nested
                    buttons inside a <button> are invalid HTML).
                  */}
                  <button
                    className={`${styles.pageHeader} ${group.pageIndex === pageIndex ? styles.pageHeaderActive : ''}`}
                    type="button"
                    onClick={() => {
                      setPageIndex(group.pageIndex);
                      if (hasChanges) togglePageGroup(group.pageIndex);
                    }}
                    aria-current={group.pageIndex === pageIndex ? 'true' : undefined}
                    aria-expanded={hasChanges ? expanded : undefined}
                    aria-controls={hasChanges ? changesId : undefined}
                    aria-label={`${diffPageLabel(group.page, t)}, ${diffPageStatusLabel(group.page.status, t)}${
                      hasChanges
                        ? `, ${translatePlural(locale, 'diff.workspace.changeCount', group.changes.length)}`
                        : ''
                    }`}
                  >
                    <span
                      className={styles.chevron}
                      data-expanded={expanded}
                      data-empty={hasChanges ? undefined : 'true'}
                      aria-hidden="true"
                    >
                      ▸
                    </span>
                    <span className={styles.pageLabel}>{diffPageLabel(group.page, t)}</span>
                    <span
                      className={styles.statusBadge}
                      data-status={group.page.status}
                    >
                      {diffPageStatusLabel(group.page.status, t)}
                    </span>
                    {hasChanges && (
                      <span className={styles.pageCount}>{group.changes.length}</span>
                    )}
                  </button>

                  {hasChanges && expanded && (
                    <ul className={styles.changeList} id={changesId}>
                      {group.changes.map(({ change, changeIndex }) => {
                        const isSelected =
                          selection?.pageIndex === group.pageIndex &&
                          selection.changeIndex === changeIndex;
                        return (
                          <li key={`${group.pageIndex}:${changeIndex}`}>
                            <button
                              className={`${styles.changeItem} ${isSelected ? styles.changeItemSelected : ''}`}
                              type="button"
                              aria-pressed={isSelected}
                              aria-label={`${change.kind} ${diffChangeTypeLabel(change.type, t)}: ${diffChangePreview(change, t)}`}
                              onClick={() => selectChangeAt(group.pageIndex, changeIndex)}
                            >
                              <span className={styles.kindBadge} data-kind={change.kind}>
                                {change.kind}
                              </span>
                              <span className={styles.changeType}>
                                {diffChangeTypeLabel(change.type, t)}
                              </span>
                              <span
                                className={styles.changePreview}
                                title={diffChangePreview(change, t)}
                              >
                                {diffChangePreview(change, t)}
                              </span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>

          <p className={styles.cliHint} title={t('diff.workspace.cliTitle')}>
            {t('diff.workspace.cliLabel')} <code>pdf-inspector diff --format html</code>
          </p>
        </aside>

        <div className={styles.center} ref={setCenterEl} data-testid="diff-center">
          {error && (
            <p className={styles.error} role="alert">
              {t('diff.workspace.failed', { error })}
            </p>
          )}

          {!result && !loading && !error && (
            <div className={styles.centerEmpty}>
              <p>{t('diff.workspace.emptyIntro')}</p>
              <button className={styles.button} type="button" onClick={openSetup}>
                {t('diff.workspace.choosePdfs')}
              </button>
            </div>
          )}

          {loading && (
            <p className={styles.centerEmpty} role="status" aria-live="polite">
              <span>
                {t('diff.workspace.comparing')}
                {' '}
                <span className={styles.elapsed} data-testid="diff-elapsed">
                  {elapsedSeconds}s
                </span>
              </span>
              {/*
                Muted reassurance for large pairs. Deliberately no percentage:
                page pairing is only known after the fingerprint pass, so any
                number here would be invented.
              */}
              <span className={styles.loadingNote}>{t('diff.workspace.comparingHint')}</span>
            </p>
          )}

          {result && page && (
            <>
              <div className={styles.pageBar}>
                <span className={styles.pageInfo}>{diffPageLabel(page, t)}</span>
                <span className={styles.statusBadge} data-status={page.status}>
                  {diffPageStatusLabel(page.status, t)}
                </span>
                {empty && (
                  <span className={styles.identicalNote} role="status">
                    {t('diff.workspace.identicalPage')}
                  </span>
                )}
                {viewMode === 'visual' && pixelStats && (
                  <span
                    className={styles.pixelStats}
                    data-testid="diff-visual-stats"
                    role="status"
                    aria-live="polite"
                  >
                    {t('diff.workspace.pixelDiff', {
                      stats: formatPixelDiffStats(pixelStats, t),
                    })}
                  </span>
                )}
              </div>

              {viewMode === 'visual' ? (
                <div className={styles.visualArea}>
                  <DiffVisualPane
                    oldSource={oldSource}
                    newSource={newSource}
                    oldPageNumber={page.oldIndex}
                    newPageNumber={page.newIndex}
                    oldSize={page.oldSize}
                    newSize={page.newSize}
                    boxes={overlayBoxes}
                    zoom={zoom}
                    opacity={visualOpacity}
                    style={visualStyle}
                    ignoreRegions={ignoreRegions}
                    onRenderStats={handleRenderStats}
                  />
                </div>
              ) : viewMode === 'side-by-side' ? (
                <div className={styles.panes}>
                  <DiffPdfPane
                    side="old"
                    label={t('diff.side.old')}
                    source={oldSource}
                    pageNumber={page.oldIndex}
                    pageSize={page.oldSize}
                    boxes={oldBoxes}
                    zoom={zoom}
                    emptyMessage={t('diff.pane.emptyOld')}
                    missingMessage={t('diff.pane.missingOld')}
                    regionMode={regionMode}
                    regions={ignoreRegions}
                    pagePair={{ oldPage: page.oldIndex, newPage: page.newIndex }}
                    onRegionComplete={addIgnoreRegion}
                  />
                  <DiffPdfPane
                    side="new"
                    label={t('diff.side.new')}
                    source={newSource}
                    pageNumber={page.newIndex}
                    pageSize={page.newSize}
                    boxes={newBoxes}
                    zoom={zoom}
                    emptyMessage={t('diff.pane.emptyNew')}
                    missingMessage={t('diff.pane.missingNew')}
                    regionMode={regionMode}
                    regions={ignoreRegions}
                    pagePair={{ oldPage: page.oldIndex, newPage: page.newIndex }}
                    onRegionComplete={addIgnoreRegion}
                  />
                </div>
              ) : (
                <div className={styles.overlayArea}>
                  <p className={styles.overlayHint}>{t('diff.workspace.overlayHint')}</p>
                  <div className={styles.panes}>
                    <DiffPdfPane
                      side="overlay"
                      label={t('diff.side.overlay')}
                      source={overlayBaseSource}
                      pageNumber={overlayPageNumber}
                      pageSize={overlayPageSize}
                      boxes={overlayBoxes}
                      zoom={zoom}
                      emptyMessage={t('diff.pane.emptyBoth')}
                      missingMessage={t('diff.pane.missingSide')}
                      regionMode={regionMode}
                      regions={ignoreRegions}
                      pagePair={{ oldPage: page.oldIndex, newPage: page.newIndex }}
                      onRegionComplete={addIgnoreRegion}
                    />
                  </div>
                </div>
              )}
            </>
          )}

          {result && !page && (
            <p className={styles.centerEmpty}>{t('diff.workspace.noPages')}</p>
          )}
        </div>

        <aside className={styles.details} aria-label={t('diff.workspace.changeDetails')}>
          {selectedDocumentChange ? (
            <DocumentChangeDetails
              change={selectedDocumentChange.change}
              pages={pages}
              onGoToPage={setPageIndex}
            />
          ) : selectedChange ? (
            <ChangeDetails change={selectedChange} pages={pages} onGoToPage={setPageIndex} />
          ) : (
            <p className={styles.hint}>{t('diff.workspace.selectChange')}</p>
          )}
          {(selection || documentSelection !== null) && (
            <button
              className={styles.linkButton}
              type="button"
              onClick={() =>
                documentSelection !== null ? selectDocumentChange(null) : selectChange(null)
              }
            >
              {t('diff.workspace.clearSelection')}
            </button>
          )}
        </aside>
      </div>
    </section>
  );
};

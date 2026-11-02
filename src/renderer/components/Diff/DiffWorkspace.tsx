import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DiffChange, DiffResult, DiffSide } from '../../../shared/diff-types';
import { ipc } from '../../services/ipc-client';
import {
  DIFF_CHANGE_KINDS,
  DIFF_OBJECT_TYPE_ORDER,
  DIFF_PAGE_STATUS_LABELS,
  buildDiffPageGroups,
  collectOverlayBoxes,
  collectPageBoxes,
  computeDiffFitZoom,
  countFilteredChanges,
  describeDiffDetails,
  diffChangePreview,
  diffPageLabel,
  formatDiffBBox,
  isDiffFilterActive,
  isDiffResultEmpty,
  isPageGeometryChange,
  pageGeometrySummary,
  suggestDiffJsonFilename,
  tableCellChanges,
} from '../../services/diff-view';
import { selectDiffPage, useDiffStore } from '../../store/diff-store';
import { DiffPdfPane } from './DiffPdfPane';
import styles from './DiffWorkspace.module.css';

/** Gap between the two side-by-side panes (see the module CSS). */
const PANE_GAP = 8;

/** Zoom step of the workspace's −/+ buttons, matching the Inspect toolbar. */
const ZOOM_STEP = 0.25;

const changePages = (change: DiffChange): string => {
  if (change.oldPage !== null && change.newPage !== null) {
    return change.oldPage === change.newPage
      ? `Page ${change.oldPage}`
      : `Old ${change.oldPage} → New ${change.newPage}`;
  }
  if (change.newPage !== null) return `New page ${change.newPage} (added)`;
  if (change.oldPage !== null) return `Old page ${change.oldPage} (removed)`;
  return '—';
};

const Summary: React.FC<{ result: DiffResult }> = ({ result }) => {
  const { summary } = result;
  const items: Array<[string, string]> = [
    ['Pages', `${result.old.pages} → ${result.new.pages}`],
    ['Changed pages', String(summary.pagesChanged)],
    ['Pages added', String(summary.pagesAdded)],
    ['Pages removed', String(summary.pagesRemoved)],
    ['Objects added', String(summary.objectsAdded)],
    ['Objects removed', String(summary.objectsRemoved)],
    ['Objects moved', String(summary.objectsMoved)],
    ['Objects modified', String(summary.objectsModified)],
  ];

  return (
    <dl className={styles.summaryGrid} aria-label="Diff summary" data-testid="diff-summary">
      {items.map(([label, value]) => (
        <div key={label} className={styles.summaryItem}>
          <dt className={styles.summaryLabel}>{label}</dt>
          <dd className={styles.summaryValue}>{value}</dd>
        </div>
      ))}
    </dl>
  );
};

const ChangeDetails: React.FC<{ change: DiffChange }> = ({ change }) => {
  const detailRows = describeDiffDetails(change);
  const cellChanges = tableCellChanges(change);
  const geometry = pageGeometrySummary(change);
  const hasText = Boolean(change.textOld) || Boolean(change.textNew);

  return (
    <div className={styles.detailBody} data-testid="diff-change-details">
      <h3 className={styles.detailTitle}>
        <span className={styles.kindBadge} data-kind={change.kind}>
          {change.kind}
        </span>
        <span className={styles.detailType}>{change.type}</span>
      </h3>

      <dl className={styles.detailList}>
        <div className={styles.detailRow}>
          <dt>Page</dt>
          <dd>{changePages(change)}</dd>
        </div>
        <div className={styles.detailRow}>
          <dt>Old box</dt>
          <dd>{formatDiffBBox(change.oldBBox)}</dd>
        </div>
        <div className={styles.detailRow}>
          <dt>New box</dt>
          <dd>{formatDiffBBox(change.newBBox)}</dd>
        </div>
      </dl>

      {geometry.length > 0 && (
        <div className={styles.geometryNote} role="note">
          {geometry.map((line) => (
            <p key={line}>{line}</p>
          ))}
          <p className={styles.geometryHint}>Page geometry is reported as a page, not an object box.</p>
        </div>
      )}

      {hasText && (
        <div className={styles.textBlock}>
          <div>
            <span className={styles.textLabel}>Old</span>
            <pre className={styles.pre}>{change.textOld ?? '—'}</pre>
          </div>
          <div>
            <span className={styles.textLabel}>New</span>
            <pre className={styles.pre}>{change.textNew ?? '—'}</pre>
          </div>
        </div>
      )}

      {detailRows.length > 0 && (
        <table className={styles.detailTable}>
          <thead>
            <tr>
              <th scope="col">Detail</th>
              <th scope="col">Old</th>
              <th scope="col">New</th>
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

      {cellChanges.length > 0 && (
        <table className={styles.detailTable} data-testid="diff-cell-changes">
          <caption className={styles.tableCaption}>Table cells</caption>
          <thead>
            <tr>
              <th scope="col">Cell</th>
              <th scope="col">Old</th>
              <th scope="col">New</th>
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
        <p className={styles.hint}>No further details for this change.</p>
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
  const result = useDiffStore((s) => s.result);
  const loading = useDiffStore((s) => s.loading);
  const error = useDiffStore((s) => s.error);
  const filter = useDiffStore((s) => s.filter);
  const viewMode = useDiffStore((s) => s.viewMode);
  const zoom = useDiffStore((s) => s.zoom);
  const pageIndex = useDiffStore((s) => s.pageIndex);
  const selection = useDiffStore((s) => s.selection);
  const oldSource = useDiffStore((s) => s.oldSource);
  const newSource = useDiffStore((s) => s.newSource);
  const oldName = useDiffStore((s) => s.oldName);
  const newName = useDiffStore((s) => s.newName);

  const setFilter = useDiffStore((s) => s.setFilter);
  const resetFilter = useDiffStore((s) => s.resetFilter);
  const setViewMode = useDiffStore((s) => s.setViewMode);
  const setZoom = useDiffStore((s) => s.setZoom);
  const setPageIndex = useDiffStore((s) => s.setPageIndex);
  const stepPage = useDiffStore((s) => s.stepPage);
  const selectChangeAt = useDiffStore((s) => s.selectChangeAt);
  const selectChange = useDiffStore((s) => s.selectChange);
  const openSetup = useDiffStore((s) => s.openSetup);
  const exitWorkspace = useDiffStore((s) => s.exitWorkspace);

  const [centerEl, setCenterEl] = useState<HTMLDivElement | null>(null);
  const [centerWidth, setCenterWidth] = useState(0);
  const fittedResultRef = useRef<DiffResult | null>(null);

  const pages = result?.pages ?? [];
  const page = result?.pages[pageIndex] ?? null;
  const groups = useMemo(() => buildDiffPageGroups(pages, filter), [pages, filter]);
  const filteredCount = useMemo(() => countFilteredChanges(pages, filter), [pages, filter]);
  const selectedChange = useMemo(() => {
    if (!result || !selection) return null;
    return result.pages[selection.pageIndex]?.changes[selection.changeIndex] ?? null;
  }, [result, selection]);

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
        useDiffStore.getState().setError(`Export failed: ${response.error}`);
      }
    } catch (err) {
      useDiffStore.getState().setError(
        err instanceof Error ? `Export failed: ${err.message}` : 'Export failed',
      );
    }
  }, []);

  const totalPages = pages.length;
  const empty = result ? isDiffResultEmpty(pages) : false;
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
    <section className={styles.workspace} aria-label="PDF diff workspace" data-testid="diff-workspace">
      <header className={styles.toolbar}>
        <button className={styles.button} type="button" onClick={exitWorkspace}>
          Back to Inspect
        </button>
        <span className={styles.separator} />
        <span className={styles.title}>Diff</span>
        <span
          className={styles.names}
          title={`${oldName ?? '—'} → ${newName ?? '—'}`}
          data-testid="diff-names"
        >
          {oldName ?? '—'} → {newName ?? '—'}
        </span>

        <span className={styles.spacer} />

        <div className={styles.group} role="group" aria-label="Diff view mode">
          <button
            className={`${styles.button} ${viewMode === 'side-by-side' ? styles.active : ''}`}
            type="button"
            aria-pressed={viewMode === 'side-by-side'}
            onClick={() => setViewMode('side-by-side')}
          >
            Side by side
          </button>
          <button
            className={`${styles.button} ${viewMode === 'overlay' ? styles.active : ''}`}
            type="button"
            aria-pressed={viewMode === 'overlay'}
            onClick={() => setViewMode('overlay')}
            title="Old and new boxes on one page"
          >
            Overlay
          </button>
        </div>

        <span className={styles.separator} />

        <div className={styles.group} role="group" aria-label="Diff zoom">
          <button
            className={styles.button}
            type="button"
            onClick={() => setZoom(zoom - ZOOM_STEP)}
            disabled={zoom <= 0.25}
            aria-label="Zoom out"
          >
            −
          </button>
          <span className={styles.value}>{Math.round(zoom * 100)}%</span>
          <button
            className={styles.button}
            type="button"
            onClick={() => setZoom(zoom + ZOOM_STEP)}
            disabled={zoom >= 5}
            aria-label="Zoom in"
          >
            +
          </button>
          <button
            className={styles.button}
            type="button"
            onClick={fitToWidth}
            disabled={!page || centerWidth <= 0}
            title="Fit page width"
          >
            Fit
          </button>
        </div>

        <span className={styles.separator} />

        <div className={styles.group} role="group" aria-label="Diff page navigation">
          <button
            className={styles.button}
            type="button"
            onClick={() => stepPage(-1)}
            disabled={!result || pageIndex <= 0}
          >
            Prev
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
            Next
          </button>
        </div>

        <span className={styles.separator} />

        <div className={styles.group}>
          <button className={styles.button} type="button" onClick={openSetup}>
            Change files…
          </button>
          <button
            className={styles.button}
            type="button"
            onClick={() => void handleExportJson()}
            disabled={!result}
            title="Save the full DiffResult as JSON"
          >
            Export JSON
          </button>
        </div>
      </header>

      <div className={styles.body}>
        <aside className={styles.summaryPane} aria-label="Diff change list">
          {result && <Summary result={result} />}

          <div className={styles.filters}>
            <label className={styles.filterLabel}>
              Kind
              <select
                className={styles.select}
                aria-label="Filter by kind"
                value={filter.kind}
                onChange={(event) =>
                  setFilter({ kind: event.target.value as typeof filter.kind })
                }
              >
                <option value="all">All kinds</option>
                {DIFF_CHANGE_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {kind}
                  </option>
                ))}
              </select>
            </label>
            <label className={styles.filterLabel}>
              Type
              <select
                className={styles.select}
                aria-label="Filter by type"
                value={filter.type}
                onChange={(event) =>
                  setFilter({ type: event.target.value as typeof filter.type })
                }
              >
                <option value="all">All types</option>
                {DIFF_OBJECT_TYPE_ORDER.map((type) => (
                  <option key={type} value={type}>
                    {type}
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
              Reset
            </button>
          </div>

          {!result && !loading && (
            <p className={styles.hint}>No comparison yet. Choose two PDFs to start.</p>
          )}

          {loading && <p className={styles.hint}>Comparing documents…</p>}

          {result && empty && (
            <p className={styles.emptyState} role="status">
              No differences found — the two documents are identical.
            </p>
          )}

          {result && !empty && filteredCount === 0 && (
            <p className={styles.emptyState} role="status">
              {isDiffFilterActive(filter)
                ? 'No changes match this filter.'
                : 'No object changes on the compared pages.'}
            </p>
          )}

          {result && filteredCount > 0 && (
            <p className={styles.listCount}>
              {filteredCount} change{filteredCount === 1 ? '' : 's'}
            </p>
          )}

          <ul className={styles.pageList} data-testid="diff-page-list">
            {groups.map((group) => (
              <li key={group.pageIndex} className={styles.pageGroup}>
                <button
                  className={`${styles.pageHeader} ${group.pageIndex === pageIndex ? styles.pageHeaderActive : ''}`}
                  type="button"
                  onClick={() => setPageIndex(group.pageIndex)}
                  aria-current={group.pageIndex === pageIndex ? 'true' : undefined}
                  aria-label={`${diffPageLabel(group.page)}, ${DIFF_PAGE_STATUS_LABELS[group.page.status]}${
                    group.changes.length > 0 ? `, ${group.changes.length} changes` : ''
                  }`}
                >
                  <span className={styles.pageLabel}>{diffPageLabel(group.page)}</span>
                  <span
                    className={styles.statusBadge}
                    data-status={group.page.status}
                  >
                    {DIFF_PAGE_STATUS_LABELS[group.page.status]}
                  </span>
                  {group.changes.length > 0 && (
                    <span className={styles.pageCount}>{group.changes.length}</span>
                  )}
                </button>

                {group.changes.length > 0 && (
                  <ul className={styles.changeList}>
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
                            aria-label={`${change.kind} ${change.type}: ${diffChangePreview(change)}`}
                            onClick={() => selectChangeAt(group.pageIndex, changeIndex)}
                          >
                            <span className={styles.kindBadge} data-kind={change.kind}>
                              {change.kind}
                            </span>
                            <span className={styles.changeType}>{change.type}</span>
                            <span className={styles.changePreview} title={diffChangePreview(change)}>
                              {diffChangePreview(change)}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </li>
            ))}
          </ul>

          <p
            className={styles.cliHint}
            title="HTML report: pdf-inspector diff old.pdf new.pdf --format html"
          >
            CLI: <code>pdf-inspector diff --format html</code>
          </p>
        </aside>

        <div className={styles.center} ref={setCenterEl} data-testid="diff-center">
          {error && (
            <p className={styles.error} role="alert">
              Diff failed: {error}
            </p>
          )}

          {!result && !loading && !error && (
            <div className={styles.centerEmpty}>
              <p>Compare two versions of a PDF to see what changed.</p>
              <button className={styles.button} type="button" onClick={openSetup}>
                Choose PDFs…
              </button>
            </div>
          )}

          {loading && (
            <p className={styles.centerEmpty} role="status" aria-live="polite">
              Comparing documents…
            </p>
          )}

          {result && page && (
            <>
              <div className={styles.pageBar}>
                <span className={styles.pageInfo}>{diffPageLabel(page)}</span>
                <span className={styles.statusBadge} data-status={page.status}>
                  {DIFF_PAGE_STATUS_LABELS[page.status]}
                </span>
                {empty && (
                  <span className={styles.identicalNote} role="status">
                    No differences — both documents render the same pages.
                  </span>
                )}
              </div>

              {viewMode === 'side-by-side' ? (
                <div className={styles.panes}>
                  <DiffPdfPane
                    side="old"
                    label="Old"
                    source={oldSource}
                    pageNumber={page.oldIndex}
                    pageSize={page.oldSize}
                    boxes={oldBoxes}
                    zoom={zoom}
                    emptyMessage="Choose an old PDF to compare."
                    missingMessage="This page does not exist in the old document."
                  />
                  <DiffPdfPane
                    side="new"
                    label="New"
                    source={newSource}
                    pageNumber={page.newIndex}
                    pageSize={page.newSize}
                    boxes={newBoxes}
                    zoom={zoom}
                    emptyMessage="Choose a new PDF to compare."
                    missingMessage="This page does not exist in the new document."
                  />
                </div>
              ) : (
                <div className={styles.overlayArea}>
                  <p className={styles.overlayHint}>
                    Overlay: the page’s owning document with old and new boxes (removed red, added
                    green, moved orange, modified blue).
                  </p>
                  <div className={styles.panes}>
                    <DiffPdfPane
                      side="overlay"
                      label="Overlay"
                      source={overlayBaseSource}
                      pageNumber={overlayPageNumber}
                      pageSize={overlayPageSize}
                      boxes={overlayBoxes}
                      zoom={zoom}
                      emptyMessage="Choose two PDFs to compare."
                      missingMessage="This page has no renderable side."
                    />
                  </div>
                </div>
              )}
            </>
          )}

          {result && !page && (
            <p className={styles.centerEmpty}>This comparison has no pages to display.</p>
          )}
        </div>

        <aside className={styles.details} aria-label="Change details">
          {selectedChange ? (
            <ChangeDetails change={selectedChange} />
          ) : (
            <p className={styles.hint}>Select a change to see its text, boxes and details.</p>
          )}
          {selection && (
            <button
              className={styles.linkButton}
              type="button"
              onClick={() => selectChange(null)}
            >
              Clear selection
            </button>
          )}
        </aside>
      </div>
    </section>
  );
};

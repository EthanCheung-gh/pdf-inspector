import React, { useId, useMemo } from 'react';
import { usePageNavigation } from '../../hooks/usePageNavigation';
import {
  ANNOTATION_KINDS,
  ANNOTATION_KIND_LABELS,
  annotationKindLabel,
  annotationSubtypeLabel,
  filterAnnotations,
  formatAnnotationValue,
} from '../../services/annotations';
import { useAnnotationStore, type AnnotationKindFilter } from '../../store/annotation-store';
import { usePdfStore } from '../../store/pdf-store';
import { useWorkspaceStore } from '../../store/workspace-store';
import type { AnnotationKind, PdfAnnotation } from '../../types/annotations';
import styles from './AnnotationsTab.module.css';

/** Badge colour per kind; mirrors the annotation overlay palette. */
const KIND_BADGE_CLASSES: Record<AnnotationKind, string> = {
  link: styles.badgeLink,
  form: styles.badgeForm,
  markup: styles.badgeMarkup,
  note: styles.badgeNote,
  stamp: styles.badgeStamp,
  other: styles.badgeOther,
};

/**
 * One-line row preview: the link target, the form field (with its value), or
 * the annotation's title/contents. The list is the only place where the target
 * of a link is visible without selecting it.
 */
export function annotationRowPreview(annotation: PdfAnnotation): string {
  const link = annotation.link;
  if (link !== null) {
    if (link.url !== null) return link.url;
    // Display-only: `unsafeUrl` is never an activation target, but it is the
    // only way to show what a refused link pointed at.
    if (link.unsafeUrl !== null) return link.unsafeUrl;
    if (link.internalPage !== null) return `Go to page ${link.internalPage}`;
  }

  const form = annotation.form;
  if (form !== null) {
    const value = formatAnnotationValue(form.value);
    if (form.fieldName !== null) {
      return value.length > 0 ? `${form.fieldName} = ${value}` : form.fieldName;
    }
    if (value.length > 0) return value;
  }

  const title = annotation.title;
  const contents = annotation.contents;
  if (title !== null && contents !== null && title !== contents) {
    return `${title} — ${contents}`;
  }
  return title ?? contents ?? '';
}

/**
 * `N annotations · L links · F form fields`, where `annotations` is the full
 * page count. While a filter is active the visible count is reported as
 * `2 of 5 annotations` and the two other counts describe the visible rows, so
 * the summary always matches the list underneath it.
 */
export function annotationSummary(
  annotations: readonly PdfAnnotation[],
  visible: readonly PdfAnnotation[],
  filtered: boolean,
): string {
  const counted = filtered ? visible : annotations;
  const annotationCount = filtered
    ? `${visible.length} of ${annotations.length} annotations`
    : countLabel(annotations.length, 'annotation', 'annotations');

  return [
    annotationCount,
    countLabel(countOfKind(counted, 'link'), 'link', 'links'),
    countLabel(countOfKind(counted, 'form'), 'form field', 'form fields'),
  ].join(' · ');
}

/** Raw subtypes present on the page, sorted for a stable filter menu. */
export function subtypeFilterOptions(annotations: readonly PdfAnnotation[]): string[] {
  const subtypes = new Set<string>();
  for (const annotation of annotations) {
    const subtype = annotation.subtype.trim();
    if (subtype.length > 0) subtypes.add(subtype);
  }
  return Array.from(subtypes).sort((left, right) => left.toLowerCase().localeCompare(right.toLowerCase()));
}

function countLabel(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function countOfKind(annotations: readonly PdfAnnotation[], kind: AnnotationKind): number {
  return annotations.reduce((total, annotation) => (annotation.kind === kind ? total + 1 : total), 0);
}

/**
 * Current-page annotation list.
 *
 * The list is read-only and page-scoped: it renders whatever the annotation
 * store holds for the page on screen, which `usePageAnnotations` keeps in sync
 * with page navigation. Selecting a row shares the selection with the canvas
 * overlay and opens the Inspect tab, where `AnnotationDetails` renders it.
 */
export const AnnotationsTab: React.FC = () => {
  const filePath = usePdfStore((state) => state.filePath);
  const currentPage = usePdfStore((state) => state.currentPage);
  const pageData = usePdfStore((state) => state.pageData);
  const pageLoading = usePdfStore((state) => state.isLoading);
  const pageError = usePdfStore((state) => state.error);
  const { navigate } = usePageNavigation();

  const annotations = useAnnotationStore((state) => state.annotations);
  const page = useAnnotationStore((state) => state.page);
  const loading = useAnnotationStore((state) => state.loading);
  const error = useAnnotationStore((state) => state.error);
  const selected = useAnnotationStore((state) => state.selected);
  const kindFilter = useAnnotationStore((state) => state.kindFilter);
  const subtypeFilter = useAnnotationStore((state) => state.subtypeFilter);
  const showBoxes = useAnnotationStore((state) => state.showBoxes);
  const setSelected = useAnnotationStore((state) => state.setSelected);
  const setKindFilter = useAnnotationStore((state) => state.setKindFilter);
  const setSubtypeFilter = useAnnotationStore((state) => state.setSubtypeFilter);
  const setShowBoxes = useAnnotationStore((state) => state.setShowBoxes);
  const requestReload = useAnnotationStore((state) => state.requestReload);

  const kindFilterId = useId();
  const subtypeFilterId = useId();

  const visible = useMemo(
    () => filterAnnotations(annotations, kindFilter, subtypeFilter),
    [annotations, kindFilter, subtypeFilter],
  );
  const subtypes = useMemo(() => {
    const options = subtypeFilterOptions(annotations);
    // Filters survive page changes, so the active subtype may not exist on the
    // new page. Keep it listed instead of leaving the select blank.
    if (subtypeFilter !== 'all' && !options.includes(subtypeFilter)) {
      options.push(subtypeFilter);
    }
    return options;
  }, [annotations, subtypeFilter]);
  const filtered = kindFilter !== 'all' || subtypeFilter !== 'all';
  // Annotation geometry is normalized against the MediaBox origin, so the
  // loader only starts once the page's boxes are known. Without them the
  // annotation store stays empty forever, which must not read as "loading".
  const hasGeometry = pageData?.boxes?.media != null;
  // The store may still hold the previous page (or nothing) while the loader is
  // waiting for that page's annotations; that is a pending state, not empty.
  const showingPage = page ?? currentPage;
  const pending = loading || page !== currentPage;

  if (!filePath) {
    return <div className={styles.emptyState}>Open a PDF to inspect annotations.</div>;
  }

  if (!hasGeometry) {
    if (pageLoading) {
      return (
        <div className={styles.stateBox} role="status">
          Loading annotations…
        </div>
      );
    }

    return (
      <div className={styles.stateBox}>
        <div role="status">Page geometry unavailable; annotations need page data.</div>
        {/* Only a failed extraction is retryable: re-extract the page through
            the guarded navigation. A page that extracted without boxes (older
            sidecar) has nothing to retry. */}
        {pageError !== null && (
          <button
            type="button"
            className={styles.retry}
            onClick={() => void navigate(currentPage)}
          >
            Retry page load
          </button>
        )}
      </div>
    );
  }

  if (error !== null) {
    return (
      <div className={styles.stateBox} role="alert">
        <div>{error}</div>
        <button type="button" className={styles.retry} onClick={requestReload}>
          Retry
        </button>
      </div>
    );
  }

  if (pending) {
    return (
      <div className={styles.stateBox} role="status">
        Loading annotations…
      </div>
    );
  }

  if (annotations.length === 0) {
    return (
      <div className={styles.emptyState} role="status">
        No annotations on page {showingPage}.
      </div>
    );
  }

  const handleSelect = (annotation: PdfAnnotation): void => {
    setSelected(annotation);
    // Mirror the canvas path: only one selection may be active, so the object
    // selection (and its gold highlight) plus the hover preview are dropped
    // before the Inspector switches to the annotation.
    const pdfStore = usePdfStore.getState();
    pdfStore.setSelectedObject(null);
    pdfStore.setHoveredObject(null);
    // Selecting from the list is the same gesture as clicking its box: the
    // details belong in the Inspector, not in this narrow panel.
    useWorkspaceStore.getState().setInspectorTab('inspect');
  };

  return (
    <div className={styles.panel}>
      <div className={styles.summary} role="status">
        {annotationSummary(annotations, visible, filtered)}
      </div>

      <div className={styles.controls}>
        <label className={styles.checkLabel}>
          <input
            type="checkbox"
            checked={showBoxes}
            onChange={(event) => setShowBoxes(event.target.checked)}
          />
          Show boxes
        </label>

        <div className={styles.filterRow}>
          <label className={styles.filterLabel} htmlFor={kindFilterId}>
            Kind
          </label>
          <select
            id={kindFilterId}
            className={styles.select}
            value={kindFilter}
            onChange={(event) => setKindFilter(event.target.value as AnnotationKindFilter)}
          >
            <option value="all">All kinds</option>
            {ANNOTATION_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {ANNOTATION_KIND_LABELS[kind]}
              </option>
            ))}
          </select>
        </div>

        <div className={styles.filterRow}>
          <label className={styles.filterLabel} htmlFor={subtypeFilterId}>
            Subtype
          </label>
          <select
            id={subtypeFilterId}
            className={styles.select}
            value={subtypeFilter}
            onChange={(event) => setSubtypeFilter(event.target.value)}
          >
            <option value="all">All subtypes</option>
            {subtypes.map((subtype) => (
              <option key={subtype} value={subtype}>
                {annotationSubtypeLabel(subtype)}
              </option>
            ))}
          </select>
        </div>
      </div>

      {visible.length === 0 ? (
        <div className={styles.emptyState} role="status">
          No annotations match the current filters.
        </div>
      ) : (
        <ul className={styles.list} aria-label={`Annotations on page ${showingPage}`}>
          {visible.map((annotation) => {
            const preview = annotationRowPreview(annotation);
            const isSelected = selected !== null && selected.id === annotation.id;

            return (
              <li className={styles.item} key={annotation.id}>
                <button
                  type="button"
                  className={`${styles.row} ${isSelected ? styles.selected : ''}`}
                  aria-pressed={isSelected}
                  title={annotationSubtypeLabel(annotation.subtype)}
                  onClick={() => handleSelect(annotation)}
                >
                  <span className={styles.rowHeader}>
                    <span className={`${styles.badge} ${KIND_BADGE_CLASSES[annotation.kind]}`}>
                      {annotationKindLabel(annotation.kind)}
                    </span>
                    <span className={styles.subtype}>
                      {annotationSubtypeLabel(annotation.subtype)}
                    </span>
                    {annotation.hidden && (
                      <span className={styles.hiddenMarker} title="Hidden annotation">
                        Hidden
                      </span>
                    )}
                    <span className={styles.page} title={`Page ${annotation.page}`}>
                      p.{annotation.page}
                    </span>
                  </span>
                  {preview.length > 0 && <span className={styles.preview}>{preview}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};

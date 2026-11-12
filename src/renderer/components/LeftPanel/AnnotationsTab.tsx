import React, { useId, useMemo, useState } from 'react';
import { annotationDocumentKey, annotationIndexPageTotal, useAnnotationIndex } from '../../hooks/useAnnotationIndex';
import { usePageNavigation } from '../../hooks/usePageNavigation';
import { DEFAULT_LOCALE } from '../../i18n/locales';
import { translate, useT, type MessageKey, type TranslateFn } from '../../i18n';
import type {
  AnnotationFormIssue,
  AnnotationIndexSummary,
  AnnotationLinkIssue,
} from '../../services/annotation-index';
import {
  ANNOTATION_KINDS,
  annotationKindLabel,
  annotationSearchText,
  annotationSubtypeLabel,
  filterAnnotations,
  formatAnnotationValue,
} from '../../services/annotations';
import {
  useAnnotationIndexStore,
  type AnnotationIndexKindFilter,
} from '../../store/annotation-index-store';
import { useAnnotationStore, type AnnotationKindFilter } from '../../store/annotation-store';
import { usePdfStore } from '../../store/pdf-store';
import { useWorkspaceStore } from '../../store/workspace-store';
import type { AnnotationKind, PdfAnnotation } from '../../types/annotations';
import { AnnotationExportDialog } from './AnnotationExportDialog';
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
 * Which list the tab shows: the annotations of the page on screen, or every
 * annotation of the document. The current page stays the default.
 */
export type AnnotationScope = 'page' | 'document';

/** Ordered options of the mode switch. */
export const ANNOTATION_SCOPES: ReadonlyArray<{ value: AnnotationScope; labelKey: MessageKey }> = [
  { value: 'page', labelKey: 'annots.scope.page' },
  { value: 'document', labelKey: 'annots.scope.document' },
];

/**
 * English translator for the exported pure helpers below (and for plain unit
 * tests). Components always pass their `useT()` translator, so a locale switch
 * re-renders the summary without leaving hard-coded English behind.
 */
const defaultTranslate: TranslateFn = (key, params) => translate(DEFAULT_LOCALE, key, params);

/**
 * One/other form of a count through a `TranslateFn`.
 *
 * Both catalogs define the two suffixes and the shipped locales only use the
 * `one`/`other` categories, so the comparison is exact; components use
 * `translatePlural` wherever they have the locale at hand.
 */
const countLabel = (t: TranslateFn, count: number, one: MessageKey, other: MessageKey): string =>
  t(count === 1 ? one : other, { count });

/** Stable empty list so an unindexed document keeps one array reference. */
const EMPTY_ANNOTATIONS: PdfAnnotation[] = [];

/** Same for the health-check lists of a document without an index. */
const EMPTY_LINK_ISSUES: AnnotationLinkIssue[] = [];
const EMPTY_FORM_ISSUES: AnnotationFormIssue[] = [];

/**
 * One-line row preview: the link target, the form field (with its value), or
 * the annotation's title/contents. The list is the only place where the target
 * of a link is visible without selecting it.
 */
export function annotationRowPreview(
  annotation: PdfAnnotation,
  t: TranslateFn = defaultTranslate,
): string {
  const link = annotation.link;
  if (link !== null) {
    if (link.url !== null) return link.url;
    // Display-only: `unsafeUrl` is never an activation target, but it is the
    // only way to show what a refused link pointed at.
    if (link.unsafeUrl !== null) return link.unsafeUrl;
    if (link.internalPage !== null) {
      return t('annots.preview.goToPage', { page: link.internalPage });
    }
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
  t: TranslateFn = defaultTranslate,
): string {
  const counted = filtered ? visible : annotations;
  const annotationCount = filtered
    ? t('annots.summary.filtered', { visible: visible.length, total: annotations.length })
    : countLabel(t, annotations.length, 'annots.count.annotation.one', 'annots.count.annotation.other');

  return [
    annotationCount,
    countLabel(t, countOfKind(counted, 'link'), 'annots.count.link.one', 'annots.count.link.other'),
    countLabel(
      t,
      countOfKind(counted, 'form'),
      'annots.count.formField.one',
      'annots.count.formField.other',
    ),
  ].join(' · ');
}

/**
 * `N annotations · P pages · L links · F form fields` for the whole document.
 *
 * The counts come from the index summary, which is computed once while the
 * document is read, so the list never re-counts on every render.
 */
export function documentAnnotationSummary(
  summary: AnnotationIndexSummary,
  t: TranslateFn = defaultTranslate,
): string {
  return [
    countLabel(t, summary.annotations, 'annots.count.annotation.one', 'annots.count.annotation.other'),
    countLabel(t, summary.pagesWithAnnotations, 'annots.count.page.one', 'annots.count.page.other'),
    countLabel(t, summary.links, 'annots.count.link.one', 'annots.count.link.other'),
    countLabel(t, summary.formFields, 'annots.count.formField.one', 'annots.count.formField.other'),
  ].join(' · ');
}

/**
 * Link issues that describe a problem rather than an inventory entry.
 *
 * `external` is the informational list of openable http(s) targets; the two
 * other kinds are the links a reader should look at.
 */
export function isProblemLinkIssue(issue: AnnotationLinkIssue): boolean {
  return issue.kind !== 'external';
}

/**
 * Number of entries the `Issues` section reports: every non-external link
 * issue plus every form issue. External links are never counted as issues.
 */
export function documentIssueCount(
  linkIssues: readonly AnnotationLinkIssue[],
  formIssues: readonly AnnotationFormIssue[],
): number {
  return linkIssues.filter(isProblemLinkIssue).length + formIssues.length;
}

/** How many informational external-link entries the document has. */
export function externalLinkCount(linkIssues: readonly AnnotationLinkIssue[]): number {
  return linkIssues.filter((issue) => issue.kind === 'external').length;
}

/**
 * `p.2, p.4`: the pages a form issue spans. Kept in the index's ascending
 * order so a field's page list reads like a table of contents.
 */
export function issuePagesLabel(pages: readonly number[], t: TranslateFn = defaultTranslate): string {
  return pages.map((page) => t('annots.row.page', { page })).join(', ');
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

function countOfKind(annotations: readonly PdfAnnotation[], kind: AnnotationKind): number {
  return annotations.reduce((total, annotation) => (annotation.kind === kind ? total + 1 : total), 0);
}

/**
 * Issue copy for the health check.
 *
 * `annotation-index` builds its issues with English `message` text because the
 * same rows are exported as JSON data; the tab therefore derives the display
 * copy from the issue kind and its data, and falls back to the payload message
 * for anything unexpected.
 */
function linkIssueMessage(issue: AnnotationLinkIssue, t: TranslateFn): string {
  switch (issue.kind) {
    case 'unsafe':
      return t('annots.issue.unsafe', { target: issue.target ?? '' });
    case 'unresolved':
      return t('annots.issue.unresolved');
    default:
      return issue.message;
  }
}

function formIssueMessage(issue: AnnotationFormIssue, t: TranslateFn): string {
  switch (issue.kind) {
    case 'unnamed':
      return t('annots.issue.unnamed');
    case 'duplicate-name':
      return t('annots.issue.duplicateName', {
        name: issue.fieldName ?? '',
        count: issue.pages.length,
      });
    case 'conflicting-type':
      return t('annots.issue.conflictingType', {
        name: issue.fieldName ?? '',
        types: issue.fieldTypes.join(', '),
      });
    default:
      return issue.message;
  }
}

/** One row of either list; the presentation is what keeps both lists equal. */
const AnnotationRow: React.FC<{
  annotation: PdfAnnotation;
  selected: boolean;
  className: string;
  onActivate: (annotation: PdfAnnotation) => void;
}> = ({ annotation, selected, className, onActivate }) => {
  const t = useT();
  const preview = annotationRowPreview(annotation, t);

  return (
    <li className={className}>
      <button
        type="button"
        className={`${styles.row} ${selected ? styles.selected : ''}`}
        aria-pressed={selected}
        title={annotationSubtypeLabel(annotation.subtype)}
        onClick={() => onActivate(annotation)}
      >
        <span className={styles.rowHeader}>
          <span className={`${styles.badge} ${KIND_BADGE_CLASSES[annotation.kind]}`}>
            {annotationKindLabel(annotation.kind, t)}
          </span>
          <span className={styles.subtype}>{annotationSubtypeLabel(annotation.subtype)}</span>
          {annotation.hidden && (
            <span className={styles.hiddenMarker} title={t('annots.row.hiddenTitle')}>
              {t('annots.row.hidden')}
            </span>
          )}
          <span className={styles.page} title={t('annots.row.pageTitle', { page: annotation.page })}>
            {t('annots.row.page', { page: annotation.page })}
          </span>
        </span>
        {preview.length > 0 && <span className={styles.preview}>{preview}</span>}
      </button>
    </li>
  );
};

/**
 * Annotation list with two scopes.
 *
 * `Current page` renders whatever the annotation store holds for the page on
 * screen (kept in sync by `usePageAnnotations`). `Whole document` reads the
 * batched document index, which is started the first time the mode is opened and
 * keeps running while the user looks at a single page, so switching back and
 * forth never restarts it. Both lists are read-only; selecting a row shares the
 * selection with the canvas overlay and opens the Inspect tab, where
 * `AnnotationDetails` renders it.
 */
export const AnnotationsTab: React.FC = () => {
  const t = useT();
  const filePath = usePdfStore((state) => state.filePath);
  const sourceUrl = usePdfStore((state) => state.sourceUrl);
  const documentName = usePdfStore((state) => state.documentName);
  const pageCount = usePdfStore((state) => state.pageCount);
  const pdfDoc = usePdfStore((state) => state.pdfDocRef);
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

  const [scope, setScope] = useState<AnnotationScope>('page');
  // The export dialog is document-scope only: the current page list keeps the
  // existing toolbar object export and never offers an annotation export.
  const [exportOpen, setExportOpen] = useState(false);
  const documentKey = annotationDocumentKey(filePath, sourceUrl);
  // The index is only *started* in document mode, but the hook stays mounted in
  // both modes, so a running index keeps going when the user goes back to the
  // current page and its result is still there when they return.
  const { retry } = useAnnotationIndex(pdfDoc, documentKey, pageCount, scope === 'document');

  const indexDocumentKey = useAnnotationIndexStore((state) => state.documentKey);
  const indexStatus = useAnnotationIndexStore((state) => state.status);
  const indexProgress = useAnnotationIndexStore((state) => state.progress);
  const indexResult = useAnnotationIndexStore((state) => state.result);
  const indexError = useAnnotationIndexStore((state) => state.error);
  const indexQuery = useAnnotationIndexStore((state) => state.query);
  const indexKindFilter = useAnnotationIndexStore((state) => state.kindFilter);
  const indexSubtypeFilter = useAnnotationIndexStore((state) => state.subtypeFilter);
  const setIndexQuery = useAnnotationIndexStore((state) => state.setQuery);
  const setIndexKindFilter = useAnnotationIndexStore((state) => state.setKindFilter);
  const setIndexSubtypeFilter = useAnnotationIndexStore((state) => state.setSubtypeFilter);

  const kindFilterId = useId();
  const subtypeFilterId = useId();
  const documentKindFilterId = useId();
  const documentSubtypeFilterId = useId();
  const searchInputId = useId();

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

  // The document index has its own query and filters: switching scope must not
  // rewrite what the other list is filtered by.
  const documentAnnotations = indexResult?.annotations ?? EMPTY_ANNOTATIONS;
  const documentVisible = useMemo(() => {
    if (indexResult === null) return EMPTY_ANNOTATIONS;

    const kindAndSubtype = filterAnnotations(
      indexResult.annotations,
      indexKindFilter,
      indexSubtypeFilter,
    );
    // `annotationSearchText` is already folded to lower case; the needle is
    // trimmed and folded the same way before matching.
    const needle = indexQuery.trim().toLowerCase();
    if (needle.length === 0) return kindAndSubtype;
    return kindAndSubtype.filter((annotation) => annotationSearchText(annotation).includes(needle));
  }, [indexResult, indexKindFilter, indexSubtypeFilter, indexQuery]);
  const documentSubtypes = useMemo(() => {
    const options = subtypeFilterOptions(documentAnnotations);
    if (indexSubtypeFilter !== 'all' && !options.includes(indexSubtypeFilter)) {
      options.push(indexSubtypeFilter);
    }
    return options;
  }, [documentAnnotations, indexSubtypeFilter]);

  // Health check lists, split once per index: `linkProblems` feeds the open
  // `Issues` block, `externalLinks` the collapsed informational one. Nothing
  // here ever opens a URL; the targets are only shown and jumped to.
  const { linkProblems, externalLinks, formIssues, issueCount } = useMemo(() => {
    const linkIssues = indexResult?.linkIssues ?? EMPTY_LINK_ISSUES;
    const issues = indexResult?.formIssues ?? EMPTY_FORM_ISSUES;
    return {
      linkProblems: linkIssues.filter(isProblemLinkIssue),
      externalLinks: linkIssues.filter((issue) => issue.kind === 'external'),
      formIssues: issues,
      issueCount: documentIssueCount(linkIssues, issues),
    };
  }, [indexResult]);

  // Annotation geometry is normalized against the MediaBox origin, so the
  // loader only starts once the page's boxes are known. Without them the
  // annotation store stays empty forever, which must not read as "loading".
  const hasGeometry = pageData?.boxes?.media != null;
  // The store may still hold the previous page (or nothing) while the loader is
  // waiting for that page's annotations; that is a pending state, not empty.
  const showingPage = page ?? currentPage;
  const pending = loading || page !== currentPage;

  /**
   * Mirrors the canvas path: only one selection may be active, so the object
   * selection (and its gold highlight) plus the hover preview are dropped before
   * the Inspector switches to the annotation.
   */
  const focusSelection = (annotation: PdfAnnotation | null): void => {
    setSelected(annotation);
    const pdfStore = usePdfStore.getState();
    pdfStore.setSelectedObject(null);
    pdfStore.setHoveredObject(null);
    // Selecting from a list is the same gesture as clicking its box: the details
    // belong in the Inspector, not in this narrow panel.
    useWorkspaceStore.getState().setInspectorTab('inspect');
  };

  /**
   * Document-mode row click: select now when the annotation is already loaded,
   * otherwise navigate and let the page loader apply the pending id.
   */
  const activateDocumentRow = async (annotation: PdfAnnotation): Promise<void> => {
    const store = useAnnotationStore.getState();
    const current = usePdfStore.getState().currentPage;
    if (store.page === annotation.page && annotation.page === current) {
      const loaded = store.annotations.find((entry) => entry.id === annotation.id) ?? null;
      if (loaded !== null) {
        focusSelection(loaded);
        return;
      }
    }

    focusSelection(null);
    store.requestSelection(annotation.id);
    await navigate(annotation.page);

    const after = useAnnotationStore.getState();
    // Navigating resets the page data while the target page's annotations are
    // still loading, which also drops the pending id; the request is therefore
    // re-asserted and applied by the next page load instead of being lost.
    if (after.page === annotation.page) {
      after.requestSelection(null);
      const loaded = after.annotations.find((entry) => entry.id === annotation.id) ?? null;
      if (loaded !== null) after.setSelected(loaded);
      return;
    }

    after.requestSelection(annotation.id);
    after.requestReload();
  };

  /**
   * Issue rows navigate through the same path as document rows: the reported
   * annotation is looked up in the finished index, so the jump lands on the
   * page that owns it and asks for its selection like a row click does. A link
   * issue whose annotation is missing (stale issue list) still jumps to the
   * recorded page instead of doing nothing.
   */
  const activateLinkIssue = (issue: AnnotationLinkIssue): void => {
    const annotation =
      indexResult?.annotations.find((entry) => entry.id === issue.annotationId) ?? null;
    if (annotation === null) {
      void navigate(issue.page);
      return;
    }
    void activateDocumentRow(annotation);
  };

  /**
   * Form issues are field groupings, not annotations: there is no widget id to
   * select (an `unnamed` issue names its widget, but the jump is still a page
   * move), so the jump only opens the first page the field appears on.
   */
  const activateFormIssue = (issue: AnnotationFormIssue): void => {
    const firstPage = issue.pages[0];
    if (firstPage === undefined) return;
    void navigate(firstPage);
  };

  const renderCurrentPage = (): React.ReactElement => {
    if (!hasGeometry) {
      if (pageLoading) {
        return (
          <div className={styles.stateBox} role="status">
            {t('annots.loading')}
          </div>
        );
      }

      return (
        <div className={styles.stateBox}>
          <div role="status">{t('annots.noGeometry')}</div>
          {/* Only a failed extraction is retryable: re-extract the page through
              the guarded navigation. A page that extracted without boxes (older
              sidecar) has nothing to retry. */}
          {pageError !== null && (
            <button
              type="button"
              className={styles.retry}
              onClick={() => void navigate(currentPage)}
            >
              {t('annots.retryPageLoad')}
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
            {t('common.retry')}
          </button>
        </div>
      );
    }

    if (pending) {
      return (
        <div className={styles.stateBox} role="status">
          {t('annots.loading')}
        </div>
      );
    }

    if (annotations.length === 0) {
      return (
        <div className={styles.emptyState} role="status">
          {t('annots.page.empty', { page: showingPage })}
        </div>
      );
    }

    return (
      <>
        <div className={styles.summary} role="status">
          {annotationSummary(annotations, visible, filtered, t)}
        </div>

        <div className={styles.controls}>
          {/* Boxes are a current-page concern only: the document list never
              claims geometry for a page that is not on canvas. */}
          <label className={styles.checkLabel}>
            <input
              type="checkbox"
              checked={showBoxes}
              onChange={(event) => setShowBoxes(event.target.checked)}
            />
            {t('annots.showBoxes')}
          </label>

          <div className={styles.filterRow}>
            <label className={styles.filterLabel} htmlFor={kindFilterId}>
              {t('annots.filter.kind')}
            </label>
            <select
              id={kindFilterId}
              className={styles.select}
              value={kindFilter}
              onChange={(event) => setKindFilter(event.target.value as AnnotationKindFilter)}
            >
              <option value="all">{t('annots.filter.allKinds')}</option>
              {ANNOTATION_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {annotationKindLabel(kind, t)}
                </option>
              ))}
            </select>
          </div>

          <div className={styles.filterRow}>
            <label className={styles.filterLabel} htmlFor={subtypeFilterId}>
              {t('annots.filter.subtype')}
            </label>
            <select
              id={subtypeFilterId}
              className={styles.select}
              value={subtypeFilter}
              onChange={(event) => setSubtypeFilter(event.target.value)}
            >
              <option value="all">{t('annots.filter.allSubtypes')}</option>
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
            {t('annots.noMatch')}
          </div>
        ) : (
          <ul className={styles.list} aria-label={t('annots.page.list', { page: showingPage })}>
            {visible.map((annotation) => (
              <AnnotationRow
                key={annotation.id}
                annotation={annotation}
                className={styles.item}
                selected={selected !== null && selected.id === annotation.id}
                onActivate={focusSelection}
              />
            ))}
          </ul>
        )}
      </>
    );
  };

  /**
   * `Issues` (open) plus `External links` (collapsed), shown between the
   * summary and the filters of the document list.
   *
   * The open/closed default is the whole point of the split: a broken link or an
   * inconsistent field is something to look at, an openable external target is an
   * inventory. An empty document reports nothing at all here — its empty state
   * already says everything.
   */
  const renderIssues = (): React.ReactElement | null => {
    if (documentAnnotations.length === 0 && issueCount === 0) return null;

    return (
      <>
        <details className={styles.issues} open aria-label={t('annots.issues.title')}>
          <summary className={styles.issueSummary}>
            <span className={styles.issueTitle}>{t('annots.issues.title')}</span>
            <span className={styles.issueCount}>{issueCount}</span>
          </summary>

          {issueCount === 0 ? (
            <div className={styles.issueEmpty}>{t('annots.issues.none')}</div>
          ) : (
            <ul className={styles.issueList}>
              {linkProblems.map((issue) => (
                <li
                  key={`link:${issue.annotationId}`}
                  className={`${styles.issueItem} ${styles.issueWarning}`}
                >
                  <div className={styles.issueHeader}>
                    <span className={`${styles.badge} ${styles.badgeWarning}`}>{issue.kind}</span>
                    <span className={styles.page}>{t('annots.row.page', { page: issue.page })}</span>
                    <button
                      type="button"
                      className={styles.issueAction}
                      aria-label={t('annots.issues.goToPageAria', { page: issue.page })}
                      onClick={() => activateLinkIssue(issue)}
                    >
                      {t('annots.issues.goToPage')}
                    </button>
                  </div>
                  {issue.target !== null && (
                    <div className={styles.issueTarget}>{issue.target}</div>
                  )}
                  <div className={styles.issueMessage}>{linkIssueMessage(issue, t)}</div>
                </li>
              ))}

              {formIssues.map((issue) => {
                const firstPage = issue.pages[0];
                // A cross-page field name is normal in PDF forms, so it is a
                // notice; an unnamed or type-conflicting field is a warning.
                const informational = issue.kind === 'duplicate-name';

                return (
                  <li
                    // `annotationId` keeps two unnamed widgets on one page apart:
                    // they share kind, field name and page list, and differ only
                    // in the widget that produced them.
                    key={`form:${issue.kind}:${issue.annotationId ?? issue.fieldName ?? ''}:${
                      issue.pages.join(',')
                    }`}
                    className={`${styles.issueItem} ${
                      informational ? styles.issueInfo : styles.issueWarning
                    }`}
                  >
                    <div className={styles.issueHeader}>
                      <span
                        className={`${styles.badge} ${
                          informational ? styles.badgeInfo : styles.badgeWarning
                        }`}
                      >
                        {issue.kind}
                      </span>
                      <span className={styles.issuePages}>{issuePagesLabel(issue.pages, t)}</span>
                      {firstPage !== undefined && (
                        <button
                          type="button"
                          className={styles.issueAction}
                          aria-label={t('annots.issues.goToPageAria', { page: firstPage })}
                          onClick={() => activateFormIssue(issue)}
                        >
                          {t('annots.issues.goToPage')}
                        </button>
                      )}
                    </div>
                    <div className={styles.issueMeta}>
                      {countLabel(
                        t,
                        issue.widgetCount,
                        'annots.count.widget.one',
                        'annots.count.widget.other',
                      )}
                    </div>
                    <div className={styles.issueMessage}>{formIssueMessage(issue, t)}</div>
                  </li>
                );
              })}
            </ul>
          )}
        </details>

        {externalLinks.length > 0 && (
          <details className={styles.issues} aria-label={t('annots.issues.external')}>
            <summary className={styles.issueSummary}>
              <span className={styles.issueTitle}>{t('annots.issues.external')}</span>
              <span className={styles.issueCount}>{externalLinks.length}</span>
            </summary>

            <ul className={styles.issueList}>
              {externalLinks.map((issue) => (
                <li
                  key={`external:${issue.annotationId}`}
                  className={`${styles.issueItem} ${styles.issueInfo}`}
                >
                  <div className={styles.issueHeader}>
                    <span className={`${styles.badge} ${styles.badgeInfo}`}>external</span>
                    <span className={styles.page}>{t('annots.row.page', { page: issue.page })}</span>
                    <button
                      type="button"
                      className={styles.issueAction}
                      aria-label={t('annots.issues.goToPageAria', { page: issue.page })}
                      onClick={() => activateLinkIssue(issue)}
                    >
                      {t('annots.issues.goToPage')}
                    </button>
                  </div>
                  {issue.target !== null && (
                    <div className={styles.issueTarget}>{issue.target}</div>
                  )}
                </li>
              ))}
            </ul>
          </details>
        )}
      </>
    );
  };

  const renderDocument = (): React.ReactElement => {
    if (documentKey === null) {
      return (
        <div className={styles.emptyState} role="status">
          {t('annots.doc.noDocument')}
        </div>
      );
    }

    // The file is open but PDF.js has not handed over the document yet; an index
    // cannot start before it does. `numPages` is the total the index will read,
    // so the panel and the hook never disagree about it.
    const indexTotal = annotationIndexPageTotal(pdfDoc, pageCount);
    if (pdfDoc === null || indexTotal < 1) {
      return (
        <div className={styles.stateBox} role="status">
          {t('annots.doc.waiting')}
        </div>
      );
    }

    // Only a result that belongs to this document may be shown: the store keeps
    // the last run's state until the new one starts.
    const current = indexDocumentKey === documentKey;

    // A failed index is retried from the beginning: the previous run published
    // nothing, so there is no partial result to resume from.
    if (indexStatus === 'error' && current) {
      return (
        <div className={styles.stateBox} role="alert">
          <div>{indexError ?? t('annots.doc.failed')}</div>
          <button type="button" className={styles.retry} onClick={retry}>
            {t('common.retry')}
          </button>
        </div>
      );
    }

    if (indexStatus !== 'ready' || indexResult === null || !current) {
      const done = indexProgress?.done ?? 0;
      const total = indexProgress?.total ?? indexTotal;
      const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;

      return (
        <div className={styles.progress} role="status">
          <div>
            {indexProgress === null
              ? t('annots.doc.indexing')
              : t('annots.doc.progress', { done, total })}
          </div>
          {/* The current page stays usable: this is a background read that only
              reports progress here. */}
          <div className={styles.progressTrack} aria-hidden="true">
            <div className={styles.progressFill} style={{ width: `${percent}%` }} />
          </div>
        </div>
      );
    }

    return (
      <>
        <div className={styles.summary} role="status">
          {documentAnnotationSummary(indexResult.summary, t)}
        </div>

        {/* Exporting is only offered for a finished index: there is nothing to
            serialize while indexing, and a failed run published no result. */}
        <div className={styles.exportRow}>
          <button
            type="button"
            className={styles.exportButton}
            aria-haspopup="dialog"
            aria-expanded={exportOpen}
            onClick={() => setExportOpen(true)}
          >
            {t('annots.doc.export')}
          </button>
        </div>

        {renderIssues()}

        {documentAnnotations.length > 0 && (
          <div className={styles.controls}>
            <div className={styles.filterRow}>
              <label className={styles.filterLabel} htmlFor={searchInputId}>
                {t('annots.filter.search')}
              </label>
              <input
                id={searchInputId}
                type="search"
                className={styles.searchInput}
                value={indexQuery}
                placeholder={t('annots.filter.searchPlaceholder')}
                onChange={(event) => setIndexQuery(event.target.value)}
              />
            </div>

            <div className={styles.filterRow}>
              <label className={styles.filterLabel} htmlFor={documentKindFilterId}>
                {t('annots.filter.kind')}
              </label>
              <select
                id={documentKindFilterId}
                className={styles.select}
                value={indexKindFilter}
                onChange={(event) =>
                  setIndexKindFilter(event.target.value as AnnotationIndexKindFilter)
                }
              >
                <option value="all">{t('annots.filter.allKinds')}</option>
                {ANNOTATION_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {annotationKindLabel(kind, t)}
                  </option>
                ))}
              </select>
            </div>

            <div className={styles.filterRow}>
              <label className={styles.filterLabel} htmlFor={documentSubtypeFilterId}>
                {t('annots.filter.subtype')}
              </label>
              <select
                id={documentSubtypeFilterId}
                className={styles.select}
                value={indexSubtypeFilter}
                onChange={(event) => setIndexSubtypeFilter(event.target.value)}
              >
                <option value="all">{t('annots.filter.allSubtypes')}</option>
                {documentSubtypes.map((subtype) => (
                  <option key={subtype} value={subtype}>
                    {annotationSubtypeLabel(subtype)}
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}

        {documentAnnotations.length === 0 ? (
          // Not a role=status: the summary above already announces the empty
          // document, which keeps a single live region in this panel.
          <div className={styles.emptyState}>{t('annots.doc.empty')}</div>
        ) : documentVisible.length === 0 ? (
          <div className={styles.emptyState}>{t('annots.noMatch')}</div>
        ) : (
          <ul className={styles.list} aria-label={t('annots.doc.list')}>
            {documentVisible.map((annotation) => (
              <AnnotationRow
                key={annotation.id}
                annotation={annotation}
                // Document rows are windowed by CSS: a 1000-page index lists
                // every annotation without laying all of them out at once.
                className={`${styles.item} ${styles.documentItem}`}
                selected={selected !== null && selected.id === annotation.id}
                onActivate={(entry) => void activateDocumentRow(entry)}
              />
            ))}
          </ul>
        )}

        <AnnotationExportDialog
          open={exportOpen}
          result={indexResult}
          documentName={documentName}
          sourceUrl={sourceUrl}
          filePath={filePath}
          pageCount={indexTotal}
          onClose={() => setExportOpen(false)}
        />
      </>
    );
  };

  if (!filePath) {
    return <div className={styles.emptyState}>{t('annots.empty.noDocument')}</div>;
  }

  return (
    <div className={styles.panel}>
      <div className={styles.modeSwitch} role="group" aria-label={t('annots.scope.label')}>
        {ANNOTATION_SCOPES.map((option) => (
          <button
            key={option.value}
            type="button"
            className={`${styles.modeButton} ${
              scope === option.value ? styles.modeButtonActive : ''
            }`}
            aria-pressed={scope === option.value}
            onClick={() => setScope(option.value)}
          >
            {t(option.labelKey)}
          </button>
        ))}
      </div>

      {scope === 'page' ? renderCurrentPage() : renderDocument()}
    </div>
  );
};

import React, { useCallback, useMemo, useState } from 'react';
import type { AccessibilityReport, StructureNode } from '../../../shared/accessibility-types';
import type { AuditFinding, AuditSeverity } from '../../../shared/audit-types';
import {
  translatePlural,
  useI18nStore,
  useT,
  type MessageKey,
} from '../../i18n';
import { useAccessibilityStore } from '../../store/accessibility-store';
import styles from './StructureView.module.css';

/**
 * The Audit `Structure` view: the document's tagged-PDF structure tree.
 *
 * Read-only and bounded like the rest of Audit: the tree is parsed by the
 * sidecar (5000 nodes / depth 32 / 20 attributes per node), nothing here
 * executes a content stream or opens an external resource, and no editing or
 * re-tagging entry point exists. Only the shallow levels are expanded by
 * default and collapsed branches are not rendered at all, so a large document
 * stays responsive without a virtual-list dependency.
 *
 * The data comes from `accessibility-store`, which owns the request, the
 * per-file cache and the error state.
 */

export interface StructureViewProps {
  /**
   * The document Audit is showing, or null when Audit has no document.
   *
   * Passed in rather than read from `accessibility-store`: on the first switch
   * to Structure the store has not opened the file yet (`open()` runs in an
   * effect after this paint), so without the audit document the view could not
   * tell "no document" apart from "document not parsed yet".
   */
  filePath: string | null;
  /**
   * Switch the Audit workspace back to Findings with the category filter set
   * to `structure` (see `AuditWorkspace`).
   */
  onViewInFindings: () => void;
  /** Leave Audit and show `page` in Inspect (see `AuditWorkspace`). */
  onOpenPage: (page: number) => void;
}

const DASH = '—';

/** Heading roles carry an explicit level; the generic `/H` does not. */
const HEADING_ROLE = /^H[1-6]$/;

/**
 * Engine finding title -> short node badge.
 *
 * The engine aggregates per condition and names the affected node ids in the
 * finding evidence (`nodes=0/2/1 (Figure, page 3)`), so one finding can mark
 * several nodes. Matching on the title prefix keeps `audit-types` and this view
 * independent: an unknown title still marks its nodes as a generic issue.
 */
const ISSUE_LABEL_PREFIXES: ReadonlyArray<{ prefix: string; labelKey: MessageKey }> = [
  { prefix: 'Figure has no alternative text', labelKey: 'audit.structure.issue.altMissing' },
  { prefix: 'Formula has no alternative text', labelKey: 'audit.structure.issue.altMissing' },
  { prefix: 'Unknown structure role:', labelKey: 'audit.structure.issue.unknownRole' },
  { prefix: 'Structure element has no role', labelKey: 'audit.structure.issue.noRole' },
  { prefix: 'Link has no alternate description', labelKey: 'audit.structure.issue.noDescription' },
  { prefix: 'Heading levels are skipped', labelKey: 'audit.structure.issue.headingSkip' },
  { prefix: 'List has no list items', labelKey: 'audit.structure.issue.noListItems' },
  { prefix: 'List item has no LBody', labelKey: 'audit.structure.issue.noLBody' },
  { prefix: 'Table has no rows', labelKey: 'audit.structure.issue.noRows' },
  { prefix: 'Table header cell has no scope', labelKey: 'audit.structure.issue.noScope' },
];

export interface NodeIssue {
  /** Short badge label (`Alt missing`, `Unknown role`, …). */
  labelKey: MessageKey;
  /** Raw engine finding title, used as the badge tooltip. */
  title: string;
  severity: AuditSeverity;
}

/**
 * Structure node ids named by a finding evidence string.
 *
 * The collector labels every affected node as `<id> (<role>[, page N])` and
 * joins the first few with `, ` / `; `. Node ids are numeric paths (`0`, `0/2/1`)
 * and never contain a space, while role names may, so the id is matched as the
 * run of digits/slashes that precedes a parenthesised label.
 */
export function evidenceNodeIds(evidence: string | null): string[] {
  if (evidence === null || evidence === '') return [];

  const ids: string[] = [];
  const pattern = /(?:^|[=\s,;])([0-9][0-9/]*) \(/g;
  let match = pattern.exec(evidence);
  while (match !== null) {
    ids.push(match[1]);
    match = pattern.exec(evidence);
  }
  return ids;
}

/** Badge key for a finding title; unmapped titles still mark their nodes. */
export function issueLabelKey(title: string): MessageKey {
  for (const entry of ISSUE_LABEL_PREFIXES) {
    if (title.startsWith(entry.prefix)) return entry.labelKey;
  }
  return 'audit.structure.issue.other';
}

/** Node id -> the findings that named it, deduplicated per badge label. */
export function buildIssueIndex(findings: AuditFinding[]): Map<string, NodeIssue[]> {
  const index = new Map<string, NodeIssue[]>();

  for (const finding of findings) {
    if (finding.category !== 'structure') continue;

    const labelKey = issueLabelKey(finding.title);
    for (const id of evidenceNodeIds(finding.evidence)) {
      const issues = index.get(id) ?? [];
      // One badge per label: four figures without Alt are one issue, not four.
      if (issues.some((issue) => issue.labelKey === labelKey)) continue;
      issues.push({ labelKey, title: finding.title, severity: finding.severity });
      index.set(id, issues);
    }
  }

  return index;
}

export interface StructureStats {
  elements: number;
  figures: number;
  tables: number;
  lists: number;
  headings: number;
}

/** Depth-first counts of the roles the summary cards report. */
export function structureStats(structure: StructureNode[]): StructureStats {
  const stats: StructureStats = { elements: 0, figures: 0, tables: 0, lists: 0, headings: 0 };

  const walk = (nodes: StructureNode[]): void => {
    for (const node of nodes) {
      if (node.kind === 'element') {
        stats.elements += 1;
        if (node.role === 'Figure') stats.figures += 1;
        else if (node.role === 'Table') stats.tables += 1;
        else if (node.role === 'L') stats.lists += 1;
        else if (HEADING_ROLE.test(node.role)) stats.headings += 1;
      }
      if (node.children.length > 0) walk(node.children);
    }
  };

  walk(structure);
  return stats;
}

/** Every node of the forest, depth first in `/K` order. */
export function flattenStructure(structure: StructureNode[]): StructureNode[] {
  const nodes: StructureNode[] = [];

  const walk = (list: StructureNode[]): void => {
    for (const node of list) {
      nodes.push(node);
      if (node.children.length > 0) walk(node.children);
    }
  };

  walk(structure);
  return nodes;
}

/**
 * Expand the roots and the first level only.
 *
 * A 5000-node document must not paint its whole tree on entry; expanding the
 * root plus its children reveals the reading order's top two levels, which is
 * what the view is for before the user asks for more.
 */
export function defaultExpandedIds(structure: StructureNode[]): Set<string> {
  const ids = new Set<string>();

  for (const root of structure) {
    if (root.children.length === 0) continue;
    ids.add(root.id);
    for (const child of root.children) {
      if (child.children.length > 0) ids.add(child.id);
    }
  }

  return ids;
}

export interface StructureFilter {
  search: string;
  issuesOnly: boolean;
}

export interface FilteredStructure {
  /** Node ids to render, or null when nothing is filtered. */
  visible: Set<string> | null;
  /** Ancestors of the matches; they are always rendered expanded. */
  ancestors: Set<string>;
}

/** `undefined` fields are skipped: only the textual identity of a node matches. */
function matchesFilter(node: StructureNode, query: string): boolean {
  if (query === '') return true;
  return [node.role, node.rawRole, node.title, node.alt, node.actualText].some(
    (value) => value !== null && value.toLowerCase().includes(query),
  );
}

/**
 * Nodes that survive the current search / issues-only filter.
 *
 * A match keeps its ancestors visible (and expanded), so the result is always
 * a readable path from a root down to the node the user asked for.
 */
export function filterStructure(
  structure: StructureNode[],
  filter: StructureFilter,
  issueIndex: Map<string, NodeIssue[]>,
): FilteredStructure {
  const query = filter.search.trim().toLowerCase();
  if (query === '' && !filter.issuesOnly) return { visible: null, ancestors: new Set() };

  const visible = new Set<string>();
  const ancestors = new Set<string>();

  const matches = (node: StructureNode): boolean => {
    if (filter.issuesOnly && (issueIndex.get(node.id)?.length ?? 0) === 0) return false;
    return matchesFilter(node, query);
  };

  const walk = (nodes: StructureNode[], trail: string[]): boolean => {
    let matched = false;
    for (const node of nodes) {
      const path = [...trail, node.id];
      let hit = matches(node);
      if (node.children.length > 0 && walk(node.children, path)) hit = true;
      if (!hit) continue;

      matched = true;
      for (const id of path) visible.add(id);
      // Everything above the match has to be open for it to be on screen.
      for (const id of trail) ancestors.add(id);
    }
    return matched;
  };

  walk(structure, []);
  return { visible, ancestors };
}

const StructureTreeNode: React.FC<{
  node: StructureNode;
  depth: number;
  expanded: ReadonlySet<string>;
  visible: ReadonlySet<string> | null;
  issueIndex: Map<string, NodeIssue[]>;
  selectedId: string | null;
  onToggle: (id: string) => void;
  onSelect: (id: string) => void;
}> = ({ node, depth, expanded, visible, issueIndex, selectedId, onToggle, onSelect }) => {
  const t = useT();

  // With a filter active only the surviving children are rendered, so a
  // collapsed branch cannot show a node the filter excluded.
  const children =
    visible === null ? node.children : node.children.filter((child) => visible.has(child.id));
  const hasChildren = children.length > 0;
  const isExpanded = hasChildren && expanded.has(node.id);
  const issues = issueIndex.get(node.id) ?? [];
  const isSelected = selectedId === node.id;
  const pageLabel = node.page === null ? null : t('audit.page.page', { page: node.page });

  return (
    <li
      className={styles.node}
      role="treeitem"
      aria-level={depth + 1}
      aria-expanded={hasChildren ? isExpanded : undefined}
      aria-selected={isSelected}
      data-node-id={node.id}
    >
      <div
        className={`${styles.row} ${isSelected ? styles.rowSelected : ''}`}
        data-kind={node.kind}
        data-issue={issues.length > 0 ? 'true' : undefined}
      >
        {hasChildren ? (
          <button
            className={styles.toggle}
            type="button"
            aria-label={t(
              isExpanded ? 'audit.structure.collapse' : 'audit.structure.expand',
              { role: node.role },
            )}
            onClick={() => onToggle(node.id)}
          >
            <span aria-hidden="true">{isExpanded ? '▾' : '▸'}</span>
          </button>
        ) : (
          <span className={styles.toggleSpacer} aria-hidden="true" />
        )}

        <button
          className={styles.select}
          type="button"
          aria-pressed={isSelected}
          data-testid={`structure-node-${node.id}`}
          onClick={() => onSelect(node.id)}
        >
          {/* Roles are engine/schema values and stay English in both locales. */}
          <span className={styles.role}>
            {node.role === '' ? t('audit.structure.issue.noRole') : node.role}
          </span>

          {node.title !== null && node.title !== '' && (
            <span className={styles.nodeTitle} title={node.title}>
              {node.title}
            </span>
          )}

          {/* MCID/OBJR markers are contract markers, never translated. */}
          {node.mcid !== null && <span className={styles.marker}>MCID {node.mcid}</span>}
          {node.objectNumber !== null && (
            <span className={styles.marker}>OBJR {node.objectNumber}</span>
          )}

          {pageLabel !== null && <span className={styles.page}>{pageLabel}</span>}

          {issues.map((issue) => (
            <span
              key={issue.labelKey}
              className={styles.issueBadge}
              data-severity={issue.severity}
              title={issue.title}
            >
              {t(issue.labelKey)}
            </span>
          ))}
        </button>
      </div>

      {isExpanded && (
        <ul className={styles.children} role="group">
          {children.map((child) => (
            <StructureTreeNode
              key={child.id}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              visible={visible}
              issueIndex={issueIndex}
              selectedId={selectedId}
              onToggle={onToggle}
              onSelect={onSelect}
            />
          ))}
        </ul>
      )}

      {isExpanded && node.truncated && (
        <p className={styles.truncatedNote}>{t('audit.structure.childrenTruncated')}</p>
      )}
    </li>
  );
};

const valueOrDash = (value: string | number | null): string =>
  value === null || value === '' ? DASH : String(value);

const StructureNodeDetails: React.FC<{
  node: StructureNode;
  issues: NodeIssue[];
  onOpenPage: (page: number) => void;
  onViewInFindings: () => void;
}> = ({ node, issues, onOpenPage, onViewInFindings }) => {
  const t = useT();
  const attributes = Object.entries(node.attributes);
  // Captured once: narrowing a property does not survive into a callback.
  const page = node.page;

  return (
    <div className={styles.detailBody} data-testid="structure-detail">
      <h3 className={styles.detailTitle}>
        <span className={styles.role}>
          {node.role === '' ? t('audit.structure.issue.noRole') : node.role}
        </span>
        {node.title !== null && node.title !== '' && (
          <span className={styles.detailTitleText} title={node.title}>
            {node.title}
          </span>
        )}
      </h3>

      <dl className={styles.detailList}>
        <div className={styles.detailRow}>
          <dt>{t('audit.structure.detail.role')}</dt>
          <dd>{valueOrDash(node.role)}</dd>
        </div>
        <div className={styles.detailRow}>
          <dt>{t('audit.structure.detail.rawRole')}</dt>
          <dd>{valueOrDash(node.rawRole)}</dd>
        </div>
        <div className={styles.detailRow}>
          <dt>{t('audit.structure.detail.title')}</dt>
          <dd>{valueOrDash(node.title)}</dd>
        </div>
        <div className={styles.detailRow}>
          <dt>{t('audit.structure.detail.alt')}</dt>
          <dd>{valueOrDash(node.alt)}</dd>
        </div>
        <div className={styles.detailRow}>
          <dt>{t('audit.structure.detail.actualText')}</dt>
          <dd>{valueOrDash(node.actualText)}</dd>
        </div>
        <div className={styles.detailRow}>
          <dt>{t('audit.structure.detail.lang')}</dt>
          <dd>{valueOrDash(node.lang)}</dd>
        </div>
        <div className={styles.detailRow}>
          <dt>{t('audit.structure.detail.page')}</dt>
          <dd>{page === null ? t('audit.page.document') : t('audit.page.page', { page })}</dd>
        </div>
        <div className={styles.detailRow}>
          <dt>{t('audit.structure.detail.mcid')}</dt>
          <dd>{valueOrDash(node.mcid)}</dd>
        </div>
        <div className={styles.detailRow}>
          <dt>{t('audit.structure.detail.objectNumber')}</dt>
          <dd>{valueOrDash(node.objectNumber)}</dd>
        </div>
        <div className={styles.detailRow}>
          <dt>{t('audit.structure.detail.children')}</dt>
          <dd>{node.children.length}</dd>
        </div>
        <div className={styles.detailRow}>
          <dt>{t('audit.structure.detail.truncated')}</dt>
          <dd>{node.truncated ? t('audit.yes') : t('audit.no')}</dd>
        </div>
      </dl>

      {issues.length > 0 && (
        <section className={styles.block}>
          <h4 className={styles.blockTitle}>{t('audit.structure.detail.issues')}</h4>
          <ul className={styles.issueList} data-testid="structure-detail-issues">
            {issues.map((issue) => (
              <li key={issue.labelKey} className={styles.issueBadge} data-severity={issue.severity}>
                {t(issue.labelKey)}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className={styles.block}>
        <h4 className={styles.blockTitle}>{t('audit.structure.detail.attributes')}</h4>
        {attributes.length === 0 ? (
          <p className={styles.note}>{t('audit.structure.detail.noAttributes')}</p>
        ) : (
          <div className={styles.tableScroll}>
            <table className={styles.table} data-testid="structure-attributes">
              <caption className={styles.visuallyHidden}>
                {t('audit.structure.detail.attributes')}
              </caption>
              <thead>
                <tr>
                  <th scope="col">{t('audit.structure.detail.attributeKey')}</th>
                  <th scope="col">{t('audit.structure.detail.attributeValue')}</th>
                </tr>
              </thead>
              <tbody>
                {attributes.map(([key, value]) => (
                  // Attribute keys and values are raw PDF data: never translated.
                  <tr key={key}>
                    <td className={styles.attributeKey}>{key}</td>
                    <td className={styles.wrapCell}>{value ?? DASH}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className={styles.detailActions}>
        {page !== null && (
          <button
            className={styles.button}
            type="button"
            onClick={() => onOpenPage(page)}
            title={t('audit.structure.openPageTitle')}
          >
            {t('audit.structure.openPage')}
          </button>
        )}
        <button
          className={styles.button}
          type="button"
          onClick={onViewInFindings}
          title={t('audit.structure.viewInFindingsTitle')}
        >
          {t('audit.structure.viewInFindings')}
        </button>
      </div>
    </div>
  );
};

const StructureSummary: React.FC<{ report: AccessibilityReport }> = ({ report }) => {
  const t = useT();
  const stats = useMemo(() => structureStats(report.structure), [report]);

  const cards: Array<{ key: string; labelKey: MessageKey; value: number }> = [
    { key: 'elements', labelKey: 'audit.structure.card.elements', value: stats.elements },
    { key: 'figures', labelKey: 'audit.structure.card.figures', value: stats.figures },
    { key: 'tables', labelKey: 'audit.structure.card.tables', value: stats.tables },
    { key: 'lists', labelKey: 'audit.structure.card.lists', value: stats.lists },
    { key: 'headings', labelKey: 'audit.structure.card.headings', value: stats.headings },
    { key: 'findings', labelKey: 'audit.structure.card.findings', value: report.summary.total },
  ];

  const { document } = report;

  return (
    <>
      <dl
        className={styles.summary}
        aria-label={t('audit.structure.summaryLabel')}
        data-testid="structure-summary"
      >
        {cards.map((card) => (
          <div key={card.key} className={styles.summaryCard} data-card={card.key}>
            <dt className={styles.summaryLabel}>{t(card.labelKey)}</dt>
            <dd className={styles.summaryValue}>{card.value}</dd>
          </div>
        ))}
      </dl>

      <dl
        className={styles.facts}
        aria-label={t('audit.structure.factsLabel')}
        data-testid="structure-facts"
      >
        <div className={styles.fact}>
          <dt className={styles.factLabel}>{t('audit.structure.fact.tagged')}</dt>
          <dd className={styles.factValue}>{document.tagged ? t('audit.yes') : t('audit.no')}</dd>
        </div>
        <div className={styles.fact}>
          <dt className={styles.factLabel}>{t('audit.structure.fact.structTreeRoot')}</dt>
          <dd className={styles.factValue}>
            {document.hasStructTreeRoot ? t('audit.structure.present') : t('audit.structure.absent')}
          </dd>
        </div>
        <div className={styles.fact}>
          <dt className={styles.factLabel}>{t('audit.structure.fact.parentTree')}</dt>
          <dd className={styles.factValue}>
            {document.hasParentTree ? t('audit.structure.present') : t('audit.structure.absent')}
          </dd>
        </div>
        <div className={styles.fact}>
          <dt className={styles.factLabel}>{t('audit.structure.fact.language')}</dt>
          <dd className={styles.factValue}>{document.language ?? DASH}</dd>
        </div>
        <div className={styles.fact}>
          <dt className={styles.factLabel}>{t('audit.structure.fact.title')}</dt>
          {/* The PDF's own title is document data and stays as authored. */}
          <dd className={styles.factValue} title={document.title ?? undefined}>
            {document.title ?? DASH}
          </dd>
        </div>
      </dl>
    </>
  );
};

export const StructureView: React.FC<StructureViewProps> = ({
  filePath,
  onViewInFindings,
  onOpenPage,
}) => {
  const t = useT();
  const locale = useI18nStore((s) => s.locale);
  const openedFilePath = useAccessibilityStore((s) => s.filePath);
  const report = useAccessibilityStore((s) => s.report);
  const loading = useAccessibilityStore((s) => s.loading);
  const error = useAccessibilityStore((s) => s.error);
  const load = useAccessibilityStore((s) => s.load);

  // `null` means "not touched yet", so the default expansion is derived from
  // the report the user is actually looking at.
  const [expanded, setExpanded] = useState<ReadonlySet<string> | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [issuesOnly, setIssuesOnly] = useState(false);
  const [stateReport, setStateReport] = useState<AccessibilityReport | null>(report);
  const [stateFile, setStateFile] = useState<string | null>(openedFilePath);

  // A new parse (another file, or a refresh) invalidates the view state: node
  // ids belong to that tree.
  if (stateReport !== report) {
    setStateReport(report);
    setExpanded(null);
    setSelectedId(null);
  }

  // Filters describe one document, so another file starts from an unfiltered
  // tree; a refresh of the same file keeps them.
  if (stateFile !== openedFilePath) {
    setStateFile(openedFilePath);
    setSearch('');
    setIssuesOnly(false);
  }

  const structure = report?.structure ?? [];
  const flatNodes = useMemo(() => flattenStructure(structure), [structure]);
  const issueIndex = useMemo(() => buildIssueIndex(report?.findings ?? []), [report]);
  const defaultExpanded = useMemo(() => defaultExpandedIds(structure), [structure]);
  const expandedIds = expanded ?? defaultExpanded;

  const filtered = useMemo(
    () => filterStructure(structure, { search, issuesOnly }, issueIndex),
    [structure, search, issuesOnly, issueIndex],
  );

  const effectiveExpanded = useMemo(
    () =>
      filtered.ancestors.size === 0
        ? expandedIds
        : new Set<string>([...expandedIds, ...filtered.ancestors]),
    [expandedIds, filtered],
  );

  const selected = useMemo(
    () => (selectedId === null ? null : (flatNodes.find((node) => node.id === selectedId) ?? null)),
    [flatNodes, selectedId],
  );

  const handleToggle = useCallback(
    (id: string) => {
      const next = new Set(effectiveExpanded);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      setExpanded(next);
    },
    [effectiveExpanded],
  );

  const handleExpandAll = useCallback(() => {
    const all = new Set<string>();
    for (const node of flatNodes) {
      if (node.children.length === 0) continue;
      if (filtered.visible !== null && !filtered.visible.has(node.id)) continue;
      all.add(node.id);
    }
    setExpanded(all);
  }, [flatNodes, filtered]);

  const handleCollapseAll = useCallback(() => setExpanded(new Set()), []);

  const handleSelect = useCallback((id: string) => setSelectedId(id), []);

  // Audit has no document at all: the genuine empty state.
  if (filePath === null) {
    return (
      <div className={styles.container} data-testid="structure-view">
        <p className={styles.empty} data-testid="structure-no-file">
          {t('audit.structure.noFile')}
        </p>
      </div>
    );
  }

  // Audit does have a document, but `accessibility-store` has not opened it yet
  // (or still holds another file). `AuditWorkspace` calls `open()` right after
  // this paint, so the first frame must read as loading — and must never show
  // the structure of a document that is no longer on screen.
  const opened = openedFilePath === filePath;

  const errorBox = opened && error !== null && (
    <div className={styles.errorBox} role="alert">
      <p className={styles.errorText}>{t('audit.structure.failed', { error })}</p>
      <button
        className={styles.button}
        type="button"
        onClick={() => void load(true)}
        disabled={loading}
      >
        {t('common.retry')}
      </button>
    </div>
  );

  if (!opened || report === null) {
    return (
      <div className={styles.container} data-testid="structure-view">
        {errorBox || (
          <p className={styles.progress} role="status" aria-live="polite">
            {t('audit.structure.loading')}
          </p>
        )}
      </div>
    );
  }

  const { document } = report;
  const untagged = !document.tagged || !document.hasStructTreeRoot;
  const visibleCount = filtered.visible === null ? flatNodes.length : filtered.visible.size;
  const roots =
    filtered.visible === null
      ? structure
      : structure.filter((node) => filtered.visible?.has(node.id));

  return (
    <div className={styles.container} data-testid="structure-view">
      {errorBox}

      <StructureSummary report={report} />

      {document.truncated && (
        <p className={styles.note} data-testid="structure-truncated">
          {t('audit.structure.truncated')}
        </p>
      )}

      {document.skipped > 0 && (
        <p className={styles.note} data-testid="structure-skipped">
          {t('audit.structure.skipped', { count: document.skipped })}
        </p>
      )}

      {untagged ? (
        <section className={styles.emptyCard} data-testid="structure-untagged">
          <h3 className={styles.emptyTitle}>{t('audit.structure.untaggedTitle')}</h3>
          <p className={styles.empty}>
            {document.hasStructTreeRoot && !document.tagged
              ? t('audit.structure.unreadableRoot')
              : t('audit.structure.untagged')}
          </p>
          <button
            className={styles.button}
            type="button"
            onClick={onViewInFindings}
            title={t('audit.structure.viewInFindingsTitle')}
          >
            {t('audit.structure.viewInFindings')}
          </button>
        </section>
      ) : structure.length === 0 ? (
        <p className={styles.empty} data-testid="structure-empty-tree">
          {t('audit.structure.empty')}
        </p>
      ) : (
        <>
          <div
            className={styles.controls}
            role="group"
            aria-label={t('audit.structure.controlsLabel')}
          >
            <button className={styles.button} type="button" onClick={handleExpandAll}>
              {t('audit.structure.expandAll')}
            </button>
            <button className={styles.button} type="button" onClick={handleCollapseAll}>
              {t('audit.structure.collapseAll')}
            </button>
            <label className={styles.checkboxLabel}>
              <input
                type="checkbox"
                checked={issuesOnly}
                onChange={(event) => setIssuesOnly(event.target.checked)}
              />
              {t('audit.structure.issuesOnly')}
            </label>
            <label className={styles.searchLabel}>
              <span className={styles.searchCaption}>{t('audit.structure.search')}</span>
              <input
                className={styles.search}
                type="search"
                value={search}
                placeholder={t('audit.structure.searchPlaceholder')}
                title={t('audit.structure.searchTitle')}
                aria-label={t('audit.structure.searchTitle')}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
            <span className={styles.listCount} data-testid="structure-count">
              {filtered.visible === null
                ? translatePlural(locale, 'audit.structure.nodeCount', flatNodes.length)
                : t('audit.structure.filteredCount', {
                    shown: visibleCount,
                    total: flatNodes.length,
                  })}
            </span>
          </div>

          <div className={styles.panes}>
            <div className={styles.treePane}>
              {visibleCount === 0 ? (
                <p className={styles.empty} data-testid="structure-no-match">
                  {issuesOnly && search.trim() === ''
                    ? t('audit.structure.noIssueMatch')
                    : t('audit.structure.noSearchMatch')}
                </p>
              ) : (
                <ul
                  className={styles.tree}
                  role="tree"
                  aria-label={t('audit.structure.treeLabel')}
                  aria-multiselectable="false"
                >
                  {roots.map((node) => (
                    <StructureTreeNode
                      key={node.id}
                      node={node}
                      depth={0}
                      expanded={effectiveExpanded}
                      visible={filtered.visible}
                      issueIndex={issueIndex}
                      selectedId={selectedId}
                      onToggle={handleToggle}
                      onSelect={handleSelect}
                    />
                  ))}
                </ul>
              )}
            </div>

            <aside className={styles.details} aria-label={t('audit.structure.detailsLabel')}>
              {selected === null ? (
                <p className={styles.hint}>{t('audit.structure.selectNodeHint')}</p>
              ) : (
                <StructureNodeDetails
                  node={selected}
                  issues={issueIndex.get(selected.id) ?? []}
                  onOpenPage={onOpenPage}
                  onViewInFindings={onViewInFindings}
                />
              )}

              {/* No MCID -> content stream -> object mapping in this phase, so
                  the view must not pretend the element can be highlighted. */}
              <p className={styles.note} data-testid="structure-no-bbox">
                {t('audit.structure.noBbox')}
              </p>
            </aside>
          </div>
        </>
      )}
    </div>
  );
};

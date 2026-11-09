import React, { useEffect, useState } from 'react';
import { usePageNavigation } from '../../hooks/usePageNavigation';
import { usePdfStore } from '../../store/pdf-store';
import { useWorkspaceStore } from '../../store/workspace-store';
import { PageData, PdfObject, PdfObjectType } from '../../types/pdf-objects';
import styles from './StructureTree.module.css';

type ObjectGroup = {
  label: string;
  icon: string;
  objects: PdfObject[];
};

/** Words are the densest group on a text page; 50 keeps the tree usable. */
const MAX_WORDS = 50;
/**
 * Cap for every other group (rects/lines/curves/images/tables). A vector-heavy
 * page can carry thousands of objects and there is no reason to paint them all
 * in the side panel, so the rest are summarized by a truncation hint.
 */
const MAX_OBJECTS = 200;

const PAGE_JUMP_INPUT_ID = 'structure-page-jump';

const formatCoordinate = (value: number): string => Math.round(value).toString();

const truncate = (value: string, maxLength = 36): string =>
  value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;

const formatObjectLabel = (object: PdfObject): string => {
  if (object.type === 'word') return truncate(object.text);
  if (object.type === 'table') return `Table ${object.rows} × ${object.cols}`;
  if (object.type === 'image') return `Image ${object.width} × ${object.height}`;

  return `${object.type} (${formatCoordinate(object.x0)}, ${formatCoordinate(object.y0)})`;
};

/** Visible-object budget for one group: words keep the tighter 50 limit. */
const visibleLimit = (type: PdfObjectType): number =>
  type === 'word' ? MAX_WORDS : MAX_OBJECTS;

const getVisibleObjects = (type: PdfObjectType, objects: PdfObject[]): PdfObject[] =>
  objects.slice(0, visibleLimit(type));

/**
 * Resolve a `Go to page` input to a page number, or null when the input is not
 * a usable number (empty, blank, "3a", "-1"). Out-of-range numbers are clamped
 * to 1..pageCount instead of rejected, mirroring the toolbar's guard.
 */
export function parsePageJump(raw: string, pageCount: number): number | null {
  const trimmed = raw.trim();
  if (pageCount < 1 || !/^\d+$/.test(trimmed)) return null;
  const value = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(value)) return null;
  return Math.min(Math.max(value, 1), pageCount);
}

const objectId = (object: PdfObject): string =>
  `${object.type}-${object.page}-${object.x0}-${object.y0}-${object.x1}-${object.y1}`;

const objectsMatch = (first: PdfObject, second: PdfObject): boolean =>
  first.type === second.type
  && first.page === second.page
  && first.x0 === second.x0
  && first.y0 === second.y0
  && first.x1 === second.x1
  && first.y1 === second.y1;

const getPageObjects = (data: PageData): PdfObject[] => [
  ...data.chars,
  ...data.words,
  ...data.rects,
  ...data.lines,
  ...data.curves,
  ...data.images,
  ...data.tables,
];

export const StructureTree: React.FC = () => {
  const filePath = usePdfStore((state) => state.filePath);
  const metadata = usePdfStore((state) => state.metadata);
  const pageCount = usePdfStore((state) => state.pageCount);
  const currentPage = usePdfStore((state) => state.currentPage);
  const pageData = usePdfStore((state) => state.pageData);
  const selectedObject = usePdfStore((state) => state.selectedObject);
  const setSelectedObject = usePdfStore((state) => state.setSelectedObject);
  const setInspectorTab = useWorkspaceStore((state) => state.setInspectorTab);
  const { navigate } = usePageNavigation();
  // Page whose groups the user collapsed. Only the active page can be
  // collapsed, so a single page number is enough state.
  const [collapsedPage, setCollapsedPage] = useState<number | null>(null);
  const [jumpValue, setJumpValue] = useState('');

  // Any navigation (tree, toolbar, bookmark, search) starts the new page
  // expanded, so a collapse never follows the user to another page.
  useEffect(() => {
    setCollapsedPage(null);
  }, [currentPage]);

  if (!filePath || !metadata || pageCount === 0) {
    return <div className={styles.emptyState}>Open a PDF to view its structure.</div>;
  }

  const groups: ObjectGroup[] = pageData
    ? [
      { label: 'Words', icon: 'W', objects: pageData.words },
      { label: 'Rects', icon: '▭', objects: pageData.rects },
      { label: 'Lines', icon: '╱', objects: pageData.lines },
      { label: 'Curves', icon: '⌒', objects: pageData.curves },
      { label: 'Images', icon: '▧', objects: pageData.images },
      { label: 'Tables', icon: '▦', objects: pageData.tables },
    ]
    : [];

  const handleObjectClick = async (object: PdfObject): Promise<void> => {
    if (object.page === currentPage) {
      setSelectedObject(object);
      setInspectorTab('inspect');
      return;
    }

    const dataBefore = usePdfStore.getState().pageData;
    await navigate(object.page);

    const freshData = usePdfStore.getState().pageData;
    if (freshData && freshData !== dataBefore) {
      const freshObject = getPageObjects(freshData).find((candidate) => objectsMatch(candidate, object));
      if (freshObject) {
        setSelectedObject(freshObject);
        setInspectorTab('inspect');
      }
    }
  };

  // Clicking the already active page only toggles its groups; visiting another
  // page keeps the existing navigation flow (and loads it expanded).
  const handlePageClick = (pageNumber: number): void => {
    if (pageNumber === currentPage) {
      setCollapsedPage((previous) => (previous === pageNumber ? null : pageNumber));
      return;
    }

    void navigate(pageNumber);
  };

  // Invalid or empty input is ignored (the text stays so it can be corrected);
  // a valid jump clears the field and goes through the guarded navigation hook.
  const handleJumpSubmit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const target = parsePageJump(jumpValue, pageCount);
    if (target === null) return;
    setJumpValue('');
    if (target === currentPage) return;
    void navigate(target);
  };

  return (
    <div className={styles.treePanel}>
      <form className={styles.jumpForm} aria-label="Page jump" onSubmit={handleJumpSubmit}>
        <label className={styles.jumpLabel} htmlFor={PAGE_JUMP_INPUT_ID}>
          Go to page
        </label>
        <div className={styles.jumpRow}>
          <input
            id={PAGE_JUMP_INPUT_ID}
            className={styles.jumpInput}
            type="text"
            inputMode="numeric"
            autoComplete="off"
            spellCheck={false}
            placeholder={`1–${pageCount}`}
            value={jumpValue}
            onChange={(event) => setJumpValue(event.target.value)}
          />
          <button className={styles.jumpButton} type="submit">
            Go
          </button>
        </div>
      </form>

      <nav className={styles.tree} aria-label="PDF page structure">
        {Array.from({ length: pageCount }, (_, index) => {
          const pageNumber = index + 1;
          const isActive = pageNumber === currentPage;
          const isExpanded = isActive && pageData !== null && collapsedPage !== pageNumber;

          return (
            <div className={styles.page} key={pageNumber}>
              <button
                className={`${styles.pageButton} ${isActive ? styles.activePage : ''}`}
                type="button"
                onClick={() => handlePageClick(pageNumber)}
                aria-current={isActive ? 'page' : undefined}
                aria-expanded={isExpanded}
              >
                <span className={styles.pageIcon}>{isExpanded ? '▾' : '▸'}</span>
                Page {pageNumber}
              </button>

              {isExpanded && (
                <div className={styles.groups}>
                  {groups.map((group) => {
                    const type = group.objects[0]?.type;
                    const limit = type ? visibleLimit(type) : 0;
                    const visibleObjects = type ? getVisibleObjects(type, group.objects) : [];

                    return (
                      <section className={styles.group} key={group.label}>
                        <div className={styles.groupHeader}>
                          <span className={styles.groupIcon} aria-hidden="true">{group.icon}</span>
                          <span>{group.label}</span>
                          <span className={styles.count}>{group.objects.length}</span>
                        </div>
                        {visibleObjects.map((object, index) => {
                          const isSelected = selectedObject !== null && objectsMatch(selectedObject, object);
                          const label = formatObjectLabel(object);

                          return (
                            <button
                              className={`${styles.objectButton} ${isSelected ? styles.selectedObject : ''}`}
                              type="button"
                              key={`${objectId(object)}-${index}`}
                              onClick={() => void handleObjectClick(object)}
                              title={label}
                            >
                              {label}
                            </button>
                          );
                        })}
                        {group.objects.length > limit && (
                          <div className={styles.truncationHint}>
                            {`Showing first ${limit} of ${group.objects.length} ${group.label.toLowerCase()}`}
                          </div>
                        )}
                      </section>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </nav>
    </div>
  );
};

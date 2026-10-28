import React, { useEffect, useState } from 'react';
import { usePageNavigation } from '../../hooks/usePageNavigation';
import { usePdfStore } from '../../store/pdf-store';
import { PageData, PdfObject, PdfObjectType } from '../../types/pdf-objects';
import styles from './StructureTree.module.css';

type ObjectGroup = {
  label: string;
  icon: string;
  objects: PdfObject[];
};

const MAX_WORDS = 50;

const formatCoordinate = (value: number): string => Math.round(value).toString();

const truncate = (value: string, maxLength = 36): string =>
  value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;

const formatObjectLabel = (object: PdfObject): string => {
  if (object.type === 'word') return truncate(object.text);
  if (object.type === 'table') return `Table ${object.rows} × ${object.cols}`;
  if (object.type === 'image') return `Image ${object.width} × ${object.height}`;

  return `${object.type} (${formatCoordinate(object.x0)}, ${formatCoordinate(object.y0)})`;
};

const getVisibleObjects = (type: PdfObjectType, objects: PdfObject[]): PdfObject[] =>
  type === 'word' ? objects.slice(0, MAX_WORDS) : objects;

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
  const { navigate } = usePageNavigation();
  // Page whose groups the user collapsed. Only the active page can be
  // collapsed, so a single page number is enough state.
  const [collapsedPage, setCollapsedPage] = useState<number | null>(null);

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
      return;
    }

    const dataBefore = usePdfStore.getState().pageData;
    await navigate(object.page);

    const freshData = usePdfStore.getState().pageData;
    if (freshData && freshData !== dataBefore) {
      const freshObject = getPageObjects(freshData).find((candidate) => objectsMatch(candidate, object));
      if (freshObject) setSelectedObject(freshObject);
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

  return (
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
                        {type === 'word' && group.objects.length > MAX_WORDS && (
                          <div className={styles.truncationHint}>
                            Showing first {MAX_WORDS} of {group.objects.length} words
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
  );
};

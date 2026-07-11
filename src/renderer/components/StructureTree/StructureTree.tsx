import React from 'react';
import { usePdfStore } from '../../store/pdf-store';
import { PdfObject, PdfObjectType } from '../../types/pdf-objects';
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

export const StructureTree: React.FC = () => {
  const filePath = usePdfStore((state) => state.filePath);
  const metadata = usePdfStore((state) => state.metadata);
  const pageCount = usePdfStore((state) => state.pageCount);
  const currentPage = usePdfStore((state) => state.currentPage);
  const pageData = usePdfStore((state) => state.pageData);
  const selectedObject = usePdfStore((state) => state.selectedObject);
  const setPage = usePdfStore((state) => state.setPage);
  const setSelectedObject = usePdfStore((state) => state.setSelectedObject);

  if (!filePath || !metadata || pageCount === 0) {
    return (
      <aside className={styles.panel} aria-label="Document structure">
        <h2 className={styles.title}>Structure</h2>
        <div className={styles.emptyState}>Open a PDF to view its structure.</div>
      </aside>
    );
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

  const handleObjectClick = (object: PdfObject): void => {
    if (object.page !== currentPage) setPage(object.page);
    setSelectedObject(object);
  };

  return (
    <aside className={styles.panel} aria-label="Document structure">
      <h2 className={styles.title}>Structure</h2>
      <nav className={styles.tree} aria-label="PDF page structure">
        {Array.from({ length: pageCount }, (_, index) => {
          const pageNumber = index + 1;
          const isActive = pageNumber === currentPage;

          return (
            <div className={styles.page} key={pageNumber}>
              <button
                className={`${styles.pageButton} ${isActive ? styles.activePage : ''}`}
                type="button"
                onClick={() => setPage(pageNumber)}
                aria-current={isActive ? 'page' : undefined}
              >
                <span className={styles.pageIcon}>▸</span>
                Page {pageNumber}
              </button>

              {isActive && pageData && (
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
                        {visibleObjects.map((object, objectIndex) => {
                          const isSelected = selectedObject === object;
                          const label = formatObjectLabel(object);

                          return (
                            <button
                              className={`${styles.objectButton} ${isSelected ? styles.selectedObject : ''}`}
                              type="button"
                              key={`${object.type}-${object.page}-${objectIndex}`}
                              onClick={() => handleObjectClick(object)}
                              title={label}
                            >
                              {label}
                            </button>
                          );
                        })}
                      </section>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </nav>
    </aside>
  );
};

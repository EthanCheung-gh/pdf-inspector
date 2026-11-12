import React, { useCallback } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { usePageNavigation } from '../../hooks/usePageNavigation';
import { useT } from '../../i18n';
import { usePdfStore } from '../../store/pdf-store';
import type { PdfOutlineItem } from '../../types/pdf-objects';
import styles from './BookmarkTree.module.css';

interface BookmarkTreeProps {
  pdfDoc: PDFDocumentProxy | null;
}

const MAX_DEPTH = 5;
const MAX_ITEMS = 2000;

/**
 * Whether a bookmark's resolved PDF.js page index may be navigated to.
 *
 * `getPageIndex` returns a 0-based index, and a malformed outline (or one that
 * belongs to the previous document still being displayed for a moment) can
 * resolve to something that is not a page of what is open now. Navigating there
 * would ask the sidecar for a page that does not exist, which is exactly the
 * `list index out of range` failure, so the destination is checked against both
 * the store's page count and the loaded PDF.js document instead of trusting it.
 */
export function isNavigablePageIndex(
  pageIndex: number,
  pageCount: number,
  numPages: number | undefined,
): boolean {
  if (!Number.isInteger(pageIndex) || pageIndex < 0) return false;
  if (!Number.isFinite(pageCount) || pageCount < 1) return false;

  const page = pageIndex + 1;
  if (page > pageCount) return false;
  // `numPages` is always present on a real PDFDocumentProxy; when it is missing
  // the store's page count is the only bound available.
  if (typeof numPages === 'number' && Number.isFinite(numPages) && page > numPages) {
    return false;
  }
  return true;
}

export const BookmarkTree: React.FC<BookmarkTreeProps> = ({ pdfDoc }) => {
  const t = useT();
  const outline = usePdfStore((s) => s.outline);
  const pageCount = usePdfStore((s) => s.pageCount);
  const documentEpoch = usePdfStore((s) => s.documentEpoch);
  const { navigate } = usePageNavigation();

  const handleBookmarkClick = useCallback(
    async (dest: string | unknown[] | null) => {
      if (!dest || !pdfDoc || (Array.isArray(dest) && dest.length === 0)) return;

      try {
        let pageIndex: number;
        if (typeof dest === 'string') {
          const destArray = await pdfDoc.getDestination(dest);
          if (!destArray || destArray.length === 0) return;
          pageIndex = await pdfDoc.getPageIndex(destArray[0] as Parameters<PDFDocumentProxy['getPageIndex']>[0]);
        } else if (Array.isArray(dest)) {
          pageIndex = await pdfDoc.getPageIndex(dest[0] as Parameters<PDFDocumentProxy['getPageIndex']>[0]);
        } else {
          return;
        }

        // Resolving a destination is asynchronous: the user may have switched
        // documents while it ran, in which case this bookmark belongs to the
        // document they left.
        if (usePdfStore.getState().documentEpoch !== documentEpoch) {
          console.warn(
            'Ignoring bookmark destination resolved for a previous document:',
            pageIndex,
          );
          return;
        }

        if (!isNavigablePageIndex(pageIndex, pageCount, pdfDoc.numPages)) {
          // A malformed bookmark is not a fatal error: warn and leave the view
          // where it is instead of navigating to a page that does not exist.
          console.warn(
            `Ignoring bookmark destination outside the document: page index ${pageIndex} ` +
              `(${pageCount} pages)`,
          );
          return;
        }

        await navigate(pageIndex + 1);
      } catch (error) {
        console.error('Failed to resolve bookmark destination:', error);
      }
    },
    [documentEpoch, navigate, pageCount, pdfDoc],
  );

  if (!outline || outline.length === 0) {
    return <div className={styles.emptyState}>{t('bookmarks.empty')}</div>;
  }

  const totalItems = countItems(outline);
  if (totalItems > MAX_ITEMS) {
    return (
      <div className={styles.emptyState}>
        {t('bookmarks.tooMany', { count: totalItems })}
      </div>
    );
  }

  return (
    <nav className={styles.tree} aria-label={t('bookmarks.aria')}>
      {renderItems(outline, 0, handleBookmarkClick)}
    </nav>
  );
};

function countItems(items: PdfOutlineItem[]): number {
  let count = 0;
  for (const item of items) {
    count += 1 + countItems(item.items);
  }
  return count;
}

function renderItems(
  items: PdfOutlineItem[],
  depth: number,
  onClick: (dest: string | unknown[] | null) => void,
): React.ReactNode {
  if (depth >= MAX_DEPTH) return null;

  return items.map((item, index) => {
    const classNames = [styles.itemButton];
    if (item.bold) classNames.push(styles.bold);
    if (item.italic) classNames.push(styles.italic);

    const hasChildren = item.items.length > 0;
    return (
      <div key={`${index}-${item.title}`} className={styles.item}>
        <button
          className={classNames.join(' ')}
          type="button"
          onClick={() => void onClick(item.dest)}
          title={item.title}
        >
          {item.title}
        </button>
        {hasChildren && <div className={styles.nestedList}>{renderItems(item.items, depth + 1, onClick)}</div>}
      </div>
    );
  });
}

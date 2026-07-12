import React, { useCallback } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { usePageNavigation } from '../../hooks/usePageNavigation';
import { usePdfStore } from '../../store/pdf-store';
import type { PdfOutlineItem } from '../../types/pdf-objects';
import styles from './BookmarkTree.module.css';

interface BookmarkTreeProps {
  pdfDoc: PDFDocumentProxy | null;
}

const MAX_DEPTH = 5;
const MAX_ITEMS = 2000;

export const BookmarkTree: React.FC<BookmarkTreeProps> = ({ pdfDoc }) => {
  const outline = usePdfStore((s) => s.outline);
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

        await navigate(pageIndex + 1);
      } catch (error) {
        console.error('Failed to resolve bookmark destination:', error);
      }
    },
    [navigate, pdfDoc],
  );

  if (!outline || outline.length === 0) {
    return <div className={styles.emptyState}>No bookmarks found in this document.</div>;
  }

  const totalItems = countItems(outline);
  if (totalItems > MAX_ITEMS) {
    return (
      <div className={styles.emptyState}>
        This document has {totalItems} bookmarks. The outline is too large to display.
      </div>
    );
  }

  return <nav className={styles.tree} aria-label="PDF bookmarks">{renderItems(outline, 0, handleBookmarkClick)}</nav>;
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

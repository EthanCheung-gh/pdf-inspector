import React, { useEffect, useRef } from 'react';
import { TextLayer as PdfjsTextLayer, type PDFDocumentProxy } from 'pdfjs-dist';
import { mapMatchToDivOffsets, type SearchMatch } from '../../services/pdf-search';
import { usePdfStore } from '../../store/pdf-store';
import styles from './TextLayer.module.css';

interface TextLayerProps {
  pageNum: number;
  pdfDoc: PDFDocumentProxy | null;
  zoom: number;
}

interface HighlightRange {
  start: number;
  end: number;
  className: string;
}

/**
 * Wrap matched character ranges in highlight spans. Matches are
 * non-overlapping (see findMatches), so sorted ranges never intersect.
 * `divs` must be the PdfjsTextLayer's `textDivs` array — it is parallel
 * to `textContentItemsStr`, which the search index mirrors, so offsets
 * line up even with <br> siblings, empty items and markedContent wrappers.
 */
function applyHighlights(
  divs: HTMLElement[],
  matches: SearchMatch[],
  currentIndex: number,
  pageNum: number,
): void {
  const pageMatches = matches
    .map((match, index) => ({ match, index }))
    .filter(({ match }) => match.page === pageNum);
  if (pageMatches.length === 0) return;

  const divTexts = divs.map((d) => d.textContent ?? '');

  const perDiv = new Map<number, HighlightRange[]>();
  for (const { match, index } of pageMatches) {
    const className = index === currentIndex ? 'searchMatchCurrent' : 'searchMatch';
    for (const range of mapMatchToDivOffsets(match, divTexts)) {
      const list = perDiv.get(range.divIndex) ?? [];
      list.push({ start: range.start, end: range.end, className });
      perDiv.set(range.divIndex, list);
    }
  }

  for (const [divIndex, ranges] of perDiv) {
    const div = divs[divIndex];
    const text = divTexts[divIndex];
    ranges.sort((a, b) => a.start - b.start);

    const frag = document.createDocumentFragment();
    let cursor = 0;
    for (const range of ranges) {
      if (range.start > cursor) {
        frag.append(document.createTextNode(text.slice(cursor, range.start)));
      }
      const span = document.createElement('span');
      span.className = range.className;
      span.textContent = text.slice(range.start, range.end);
      frag.append(span);
      cursor = range.end;
    }
    if (cursor < text.length) {
      frag.append(document.createTextNode(text.slice(cursor)));
    }
    div.textContent = '';
    div.append(frag);
  }
}

export const TextLayer: React.FC<TextLayerProps> = ({ pageNum, pdfDoc, zoom }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const textLayerRef = useRef<PdfjsTextLayer | null>(null);
  const textSelectionMode = usePdfStore((s) => s.textSelectionMode);
  const searchMatches = usePdfStore((s) => s.searchMatches);
  const currentMatchIndex = usePdfStore((s) => s.currentMatchIndex);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !pdfDoc) return;

    let cancelled = false;
    let textLayer: PdfjsTextLayer | null = null;

    const renderText = async () => {
      try {
        const page = await pdfDoc.getPage(pageNum);
        if (cancelled) return;

        const viewport = page.getViewport({ scale: zoom });
        container.style.width = `${viewport.width}px`;
        container.style.height = `${viewport.height}px`;

        const textContent = await page.getTextContent();
        if (cancelled) return;

        container.innerHTML = '';
        textLayer = new PdfjsTextLayer({
          textContentSource: textContent,
          container,
          viewport,
        });
        await textLayer.render();
        if (cancelled) return;
        textLayerRef.current = textLayer;

        const s = usePdfStore.getState();
        if (!s.textSelectionMode) {
          applyHighlights(textLayer.textDivs, s.searchMatches, s.currentMatchIndex, pageNum);
        }
      } catch (error) {
        if (!cancelled) {
          console.error(`Unable to load text for page ${pageNum}:`, error);
        }
      }
    };

    void renderText();

    return () => {
      cancelled = true;
      textLayer?.cancel();
      textLayerRef.current = null;
      container.innerHTML = '';
      container.style.width = '';
      container.style.height = '';
    };
  }, [pageNum, pdfDoc, zoom]);

  // Re-apply highlights when the match set or active match changes
  // without re-rendering the text layer. Applying twice is harmless:
  // applyHighlights only reads textContent, which highlight spans
  // leave unchanged, and rebuilds each affected div from scratch.
  useEffect(() => {
    const textLayer = textLayerRef.current;
    if (!textLayer || textSelectionMode) return;
    applyHighlights(textLayer.textDivs, searchMatches, currentMatchIndex, pageNum);
  }, [searchMatches, currentMatchIndex, pageNum, textSelectionMode, zoom]);

  return (
    <div
      ref={containerRef}
      className={styles.textLayer}
      style={{
        pointerEvents: textSelectionMode ? 'auto' : 'none',
        userSelect: textSelectionMode ? 'text' : 'none',
      }}
      aria-hidden={!textSelectionMode}
    />
  );
};

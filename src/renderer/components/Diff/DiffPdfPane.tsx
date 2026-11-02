import React, { useEffect, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy, PageViewport } from 'pdfjs-dist';
import {
  isFileSource,
  type DiffPageSize,
  type DiffSide,
  type DiffSource,
} from '../../../shared/diff-types';
import { pathToFileUrl } from '../../../shared/path-utils';
import { diffBoxRects, type DiffBoxSpec } from '../../services/diff-view';
import { createMediaViewport } from '../../services/page-viewport';
import { ensurePdfWorker } from '../../services/pdf-worker';
import { isRenderCancelled } from '../../services/pdf-render';
import styles from './DiffPdfPane.module.css';

export interface DiffPdfPaneProps {
  /** Which side of the diff this pane shows ('overlay' draws both sides). */
  side: DiffSide | 'overlay';
  label: string;
  source: DiffSource | null;
  /** 1-based page number inside `source`, or null when the page is one-sided. */
  pageNumber: number | null;
  /** Page size in PDF points, used for the placeholder of a missing page. */
  pageSize: DiffPageSize | null;
  boxes: DiffBoxSpec[];
  zoom: number;
  emptyMessage: string;
  missingMessage: string;
}

type LoadStatus = 'idle' | 'loading' | 'ready' | 'error';

/** Resolve a diff source to something PDF.js can open. */
function sourceUrl(source: DiffSource): string | null {
  if (isFileSource(source)) {
    // The browser has no path; an object URL is the file's readable address.
    if (typeof URL.createObjectURL !== 'function') return null;
    return URL.createObjectURL(source);
  }
  if (/^(https?|blob|data):/i.test(source)) return source;
  return pathToFileUrl(source);
}

/**
 * MediaBox of a PDF.js page in the diff contract's frame: diff bboxes are
 * relative to the MediaBox origin, which the extractor reports as (0, 0).
 *
 * `DiffPage.oldSize`/`newSize` mirror `PageData.width/height`, which follow
 * pdfplumber's *rotation-aware* page size: a /Rotate 90 page already reports its
 * displayed (landscape) width and height. A viewport viewBox, however, is the
 * raw unrotated frame because PDF.js applies `rotation` itself — feeding it the
 * swapped size would transpose the page twice. So a quarter-turn page gets its
 * size swapped back before the viewport is built.
 */
function mediaBoxFor(
  page: PDFPageProxy,
  pageSize: DiffPageSize | null,
): { x0: number; y0: number; x1: number; y1: number } {
  const [, viewY0, viewX1, viewY1] = page.view;

  // `page.view` is always the raw frame, so the fallback needs no adjustment.
  if (!pageSize) {
    return { x0: 0, y0: 0, x1: viewX1, y1: viewY1 - viewY0 };
  }

  const quarterTurn = Math.abs(page.rotate ?? 0) % 180 !== 0;
  return {
    x0: 0,
    y0: 0,
    x1: quarterTurn ? pageSize.height : pageSize.width,
    y1: quarterTurn ? pageSize.width : pageSize.height,
  };
}

/**
 * One PDF.js page of a diff, with diff boxes drawn on top.
 *
 * Deliberately independent of `pdf-store` / `usePdf`: the diff workspace can be
 * open while a different document is loaded in the Inspect view, and the two
 * must never share page state. Documents and object URLs are owned by this
 * component and released on unmount or when the source changes.
 */
export const DiffPdfPane: React.FC<DiffPdfPaneProps> = ({
  side,
  label,
  source,
  pageNumber,
  pageSize,
  boxes,
  zoom,
  emptyMessage,
  missingMessage,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [status, setStatus] = useState<LoadStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [viewport, setViewport] = useState<PageViewport | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [rotation, setRotation] = useState(0);

  // Load this pane's PDF document only.
  useEffect(() => {
    setDoc(null);
    setViewport(null);
    setError(null);
    setRenderError(null);
    setRotation(0);

    if (!source) {
      setStatus('idle');
      return;
    }

    const url = sourceUrl(source);
    if (!url) {
      setStatus('error');
      setError('This document cannot be displayed in the browser');
      return;
    }
    const isObjectUrl = isFileSource(source);

    let cancelled = false;
    let loaded: PDFDocumentProxy | null = null;
    setStatus('loading');

    ensurePdfWorker();
    pdfjsLib
      .getDocument(url)
      .promise.then((document) => {
        if (cancelled) {
          void document.destroy();
          return;
        }
        loaded = document;
        setStatus('ready');
        setDoc(document);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setStatus('error');
        setError(err instanceof Error ? err.message : 'Failed to load the PDF');
      });

    return () => {
      cancelled = true;
      if (loaded) void loaded.destroy();
      if (isObjectUrl && typeof URL.revokeObjectURL === 'function') {
        URL.revokeObjectURL(url);
      }
    };
  }, [source]);

  // Render the page at the shared zoom; a page/zoom change cancels the previous
  // render task, whose rejection is expected control flow.
  useEffect(() => {
    if (!doc || pageNumber === null) {
      setViewport(null);
      return;
    }

    let cancelled = false;
    let task: pdfjsLib.RenderTask | null = null;
    setRenderError(null);

    const render = async (): Promise<void> => {
      try {
        const page = await doc.getPage(pageNumber);
        if (cancelled) return;

        const media = mediaBoxFor(page, pageSize);
        const mediaViewport = createMediaViewport(page.getViewport({ scale: zoom }), media);
        setViewport(mediaViewport);
        setRotation(mediaViewport.rotation ?? 0);

        const dpr = window.devicePixelRatio || 1;
        const renderViewport = createMediaViewport(page.getViewport({ scale: zoom * dpr }), media);

        const canvas = canvasRef.current;
        if (!canvas || cancelled) return;
        canvas.width = Math.max(1, Math.round(renderViewport.width));
        canvas.height = Math.max(1, Math.round(renderViewport.height));
        canvas.style.width = `${renderViewport.width / dpr}px`;
        canvas.style.height = `${renderViewport.height / dpr}px`;

        const context = canvas.getContext('2d');
        if (!context) return;

        task = page.render({ canvasContext: context, viewport: renderViewport });
        await task.promise;
      } catch (err) {
        if (cancelled || isRenderCancelled(err)) return;
        setRenderError(err instanceof Error ? err.message : 'Failed to render the page');
      }
    };

    void render();

    return () => {
      cancelled = true;
      if (task) task.cancel();
    };
  }, [doc, pageNumber, pageSize, zoom]);

  // Fall back to the diff page size until PDF.js reports its own viewport, so
  // the white page box is the right size immediately instead of collapsing.
  const layoutWidth = viewport?.width ?? (pageSize ? pageSize.width * zoom : 0);
  const layoutHeight = viewport?.height ?? (pageSize ? pageSize.height * zoom : 0);
  const isRotated = rotation % 360 !== 0;

  // A new page starts at its top-left; the previous page's scroll offset would
  // otherwise open the next page clipped.
  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    scroll.scrollTop = 0;
    scroll.scrollLeft = 0;
  }, [pageNumber, source]);

  // Diff boxes assume the unrotated MediaBox mapping; drawing them on a rotated
  // page would misplace every box, so they are skipped and explained instead.
  //
  // `status` is a dependency because the overlay canvas only exists once the
  // document is ready: the effect must run again when that canvas mounts even
  // if the page size did not change. `viewport` is one too: before PDF.js
  // reports the page geometry the rotation is still unknown, and drawing on the
  // provisional layout could paint boxes for a page that turns out rotated.
  useEffect(() => {
    const canvas = overlayRef.current;
    if (!canvas) return;

    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(layoutWidth));
    const height = Math.max(1, Math.round(layoutHeight));
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    const context = canvas.getContext('2d');
    if (!context) return;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
    if (!viewport || isRotated || layoutWidth <= 0 || layoutHeight <= 0) return;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);

    for (const rect of diffBoxRects(boxes, layoutWidth, layoutHeight)) {
      context.globalAlpha = rect.selected ? 0.28 : 0.16;
      context.fillStyle = rect.color;
      context.fillRect(rect.x, rect.y, rect.width, rect.height);

      context.globalAlpha = 1;
      context.strokeStyle = rect.color;
      context.lineWidth = rect.selected ? 2.5 : 1.2;
      context.strokeRect(rect.x, rect.y, rect.width, rect.height);
    }
    context.globalAlpha = 1;
  }, [boxes, isRotated, layoutHeight, layoutWidth, status, viewport]);

  const hasPage = pageNumber !== null;
  const placeholderWidth = pageSize ? pageSize.width * zoom : 0;
  const placeholderHeight = pageSize ? pageSize.height * zoom : 0;

  return (
    <section className={styles.pane} aria-label={`${label} pane`} data-side={side}>
      <header className={styles.header}>
        <span className={styles.badge}>{label}</span>
        <span className={styles.pageInfo}>
          {hasPage ? `Page ${pageNumber}` : 'No page'}
          {pageSize ? ` · ${Math.round(pageSize.width)} × ${Math.round(pageSize.height)} pt` : ''}
        </span>
      </header>

      <div className={styles.scroll} ref={scrollRef}>
        {!source && <p className={styles.state}>{emptyMessage}</p>}

        {source && status === 'loading' && <p className={styles.state}>Loading document…</p>}

        {source && status === 'error' && (
          <p className={styles.error} role="alert">
            {error ?? 'Failed to load the PDF'}
          </p>
        )}

        {source && status === 'ready' && !hasPage && (
          <div
            className={styles.placeholder}
            style={{
              width: placeholderWidth > 0 ? placeholderWidth : undefined,
              height: placeholderHeight > 0 ? placeholderHeight : undefined,
            }}
            role="status"
          >
            <span>{missingMessage}</span>
          </div>
        )}

        {source && status === 'ready' && hasPage && (
          <div
            className={styles.page}
            data-testid={`diff-pane-page-${side}`}
            style={{
              width: layoutWidth > 0 ? layoutWidth : undefined,
              height: layoutHeight > 0 ? layoutHeight : undefined,
            }}
          >
            <canvas ref={canvasRef} className={styles.canvas} />
            <canvas ref={overlayRef} className={styles.overlay} aria-hidden="true" />
            {isRotated && (
              <div className={styles.notice} role="status">
                Rotated page: diff boxes unavailable
              </div>
            )}
            {renderError && (
              <div className={styles.notice} role="alert">
                {renderError}
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
};

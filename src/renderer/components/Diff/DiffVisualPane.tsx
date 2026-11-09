import React, { useCallback, useEffect, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { isFileSource, type DiffIgnoreRegion, type DiffPageSize, type DiffSource } from '../../../shared/diff-types';
import { pathToFileUrl } from '../../../shared/path-utils';
import { diffBoxRects, type DiffBoxSpec } from '../../services/diff-view';
import { createMediaViewport } from '../../services/page-viewport';
import { ensurePdfWorker } from '../../services/pdf-worker';
import { isRenderCancelled } from '../../services/pdf-render';
import {
  clampVisualOpacity,
  computePixelDiff,
  DEFAULT_PIXEL_THRESHOLD,
  drawRectContains,
  fitBitmapSize,
  MAX_PIXEL_BITMAP_DIMENSION,
  pageDrawRect,
  pixelDiffStats,
  regionDrawRect,
  type PixelBitmapSize,
  type PixelDiffResult,
  type PixelDiffStats,
  type PixelDrawRect,
  type VisualDiffStyle,
} from '../../services/visual-diff';
import styles from './DiffVisualPane.module.css';

/** Dashed outline colour of a drawn ignore region (matches the side panes). */
export const IGNORE_REGION_COLOUR = '#7fd1ff';

export interface DiffVisualPaneProps {
  oldSource: DiffSource | null;
  newSource: DiffSource | null;
  /** 1-based page number inside the old document, or null when one-sided. */
  oldPageNumber: number | null;
  /** 1-based page number inside the new document, or null when one-sided. */
  newPageNumber: number | null;
  /** Page size in PDF points, used to fit both pages into one bitmap. */
  oldSize: DiffPageSize | null;
  newSize: DiffPageSize | null;
  /** Object boxes, drawn in the `boxes` style. */
  boxes: DiffBoxSpec[];
  /** Shared zoom; scales the composite, never the compared bitmap. */
  zoom: number;
  /** Alpha of the old page in `blend` style, 0..1. */
  opacity: number;
  style: VisualDiffStyle;
  /**
   * Drawn ignore regions (shared `DiffIgnoreRegion` contract). Regions matching
   * the old page mask old-side pixels and regions matching the new page mask
   * new-side pixels; masked pixels leave the denominator and are outlined.
   */
  ignoreRegions?: readonly DiffIgnoreRegion[];
  /** Called with the pixel stats of the current pair, or null when unavailable. */
  onRenderStats?: (stats: PixelDiffStats | null) => void;
}

type LoadStatus = 'idle' | 'loading' | 'ready' | 'error';

interface DocumentState {
  doc: PDFDocumentProxy | null;
  status: LoadStatus;
  error: string | null;
}

const IDLE_DOCUMENT: DocumentState = { doc: null, status: 'idle', error: null };

/** A rendered page held at the shared bitmap resolution. */
interface CachedSide {
  key: string;
  canvas: HTMLCanvasElement;
  rect: PixelDrawRect;
}

interface RenderCache {
  old: CachedSide | null;
  new: CachedSide | null;
  diffKey: string | null;
  diff: PixelDiffResult | null;
}

const EMPTY_CACHE = (): RenderCache => ({ old: null, new: null, diffKey: null, diff: null });

/**
 * Resolve a diff source to something PDF.js can open.
 *
 * Same rules as `DiffPdfPane` (that pane keeps its copy private so the two
 * views can evolve independently): a browser `File` becomes an object URL, an
 * absolute desktop path becomes a `file://` URL, and an already addressable URL
 * is passed through.
 */
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
 * MediaBox of a PDF.js page in the diff contract's frame (see `DiffPdfPane`):
 * the extractor reports rotation-aware page sizes while `page.view` is always
 * the raw frame, so a quarter-turn page gets its size swapped back before the
 * viewport is built.
 */
function mediaBoxFor(
  page: PDFPageProxy,
  pageSize: DiffPageSize | null,
): { x0: number; y0: number; x1: number; y1: number } {
  const [, viewY0, viewX1, viewY1] = page.view;

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

/** The page size to lay out with, falling back to the PDF.js view box. */
function pageSizeOf(page: PDFPageProxy, pageSize: DiffPageSize | null): DiffPageSize {
  if (
    pageSize &&
    Number.isFinite(pageSize.width) &&
    Number.isFinite(pageSize.height) &&
    pageSize.width > 0 &&
    pageSize.height > 0
  ) {
    return pageSize;
  }

  const [, viewY0, viewX1, viewY1] = page.view;
  const raw = { width: viewX1, height: viewY1 - viewY0 };
  const quarterTurn = Math.abs(page.rotate ?? 0) % 180 !== 0;
  return quarterTurn ? { width: raw.height, height: raw.width } : raw;
}

/**
 * One PDF.js document owned by the pane.
 *
 * The document and its object URL are released when the source changes or the
 * pane unmounts; a load that finishes after that is destroyed instead of
 * leaking. Modeled on `DiffPdfPane` so both views behave identically.
 */
function useDiffDocument(source: DiffSource | null, side: 'old' | 'new'): DocumentState {
  const [state, setState] = useState<DocumentState>(IDLE_DOCUMENT);

  useEffect(() => {
    setState(IDLE_DOCUMENT);
    if (!source) return;

    const url = sourceUrl(source);
    if (!url) {
      setState({
        doc: null,
        status: 'error',
        error: `The ${side} document cannot be displayed in the browser`,
      });
      return;
    }
    const isObjectUrl = isFileSource(source);

    let cancelled = false;
    let loaded: PDFDocumentProxy | null = null;
    setState({ doc: null, status: 'loading', error: null });

    ensurePdfWorker();
    pdfjsLib
      .getDocument(url)
      .promise.then((document) => {
        if (cancelled) {
          void document.destroy();
          return;
        }
        loaded = document;
        setState({ doc: document, status: 'ready', error: null });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({
          doc: null,
          status: 'error',
          error: err instanceof Error ? err.message : `Failed to load the ${side} PDF`,
        });
      });

    return () => {
      cancelled = true;
      if (loaded) void loaded.destroy();
      if (isObjectUrl && typeof URL.revokeObjectURL === 'function') {
        URL.revokeObjectURL(url);
      }
    };
  }, [source, side]);

  return state;
}

/** Paint a computed mask onto a composite context at the bitmap resolution. */
function drawMask(
  context: CanvasRenderingContext2D,
  diff: PixelDiffResult,
  bitmap: PixelBitmapSize,
): void {
  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = bitmap.width;
  maskCanvas.height = bitmap.height;
  const maskContext = maskCanvas.getContext('2d');
  if (!maskContext) return;

  const image = maskContext.createImageData(bitmap.width, bitmap.height);
  image.data.set(diff.mask);
  maskContext.putImageData(image, 0, 0);
  context.drawImage(maskCanvas, 0, 0);
}

/** Dashed outline around every active ignore region, on the shared bitmap. */
function drawRegionOutlines(
  context: CanvasRenderingContext2D,
  rects: readonly PixelDrawRect[],
): void {
  context.globalAlpha = 1;
  context.strokeStyle = IGNORE_REGION_COLOUR;
  context.lineWidth = 1.5;
  // jsdom and older canvas shims may not implement dashes; the outline still
  // has to be visible.
  if (typeof context.setLineDash === 'function') context.setLineDash([6, 4]);
  for (const rect of rects) {
    context.strokeRect(rect.x, rect.y, rect.width, rect.height);
  }
  if (typeof context.setLineDash === 'function') context.setLineDash([]);
}

/**
 * Visual diff: both pages of one diff page rendered into a single shared
 * bitmap, then blended, heat-mapped or boxed.
 *
 * Deliberately independent of `usePdf`: the Diff workspace may be open while a
 * different document is loaded in Inspect, and this pane only ever reads its
 * own two documents. The comparison bitmap is capped (`MAX_PIXEL_BITMAP_DIMENSION`)
 * and independent of `zoom`, so the changed-pixel numbers do not drift when the
 * user zooms; zoom only scales the composite on screen.
 */
export const DiffVisualPane: React.FC<DiffVisualPaneProps> = ({
  oldSource,
  newSource,
  oldPageNumber,
  newPageNumber,
  oldSize,
  newSize,
  boxes,
  zoom,
  opacity,
  style,
  ignoreRegions,
  onRenderStats,
}) => {
  const oldState = useDiffDocument(oldSource, 'old');
  const newState = useDiffDocument(newSource, 'new');

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const cacheRef = useRef<RenderCache>(EMPTY_CACHE());
  const runTokenRef = useRef(0);

  const [bitmapSize, setBitmapSize] = useState<PixelBitmapSize | null>(null);
  const [rendering, setRendering] = useState(false);
  const [renderError, setRenderError] = useState<string | null>(null);

  // Keep the latest callback without making it an effect dependency: the
  // workspace passes an inline handler and must not restart a render for it.
  const statsRef = useRef(onRenderStats);
  useEffect(() => {
    statsRef.current = onRenderStats;
  }, [onRenderStats]);
  const notifyStats = useCallback((stats: PixelDiffStats | null): void => {
    statsRef.current?.(stats);
  }, []);

  const oldDoc = oldState.doc;
  const newDoc = newState.doc;

  // Different documents mean the cached page bitmaps show the wrong content,
  // even when the page number and size are unchanged.
  useEffect(() => {
    cacheRef.current = EMPTY_CACHE();
  }, [oldDoc, newDoc]);

  useEffect(() => {
    const oldReady = oldDoc !== null && oldPageNumber !== null;
    const newReady = newDoc !== null && newPageNumber !== null;

    // Nothing to draw: reset instead of keeping the previous page's bitmap and
    // stats. This runs before the canvas check because the page element is not
    // mounted in this state.
    if (!oldReady && !newReady) {
      setBitmapSize(null);
      setRenderError(null);
      setRendering(false);
      notifyStats(null);
      return;
    }

    const canvas = canvasRef.current;
    const overlay = overlayRef.current;
    if (!canvas || !overlay) return;

    const runToken = (runTokenRef.current += 1);
    let cancelled = false;
    const tasks: pdfjsLib.RenderTask[] = [];
    const cache = cacheRef.current;
    const isCurrent = (): boolean => !cancelled && runTokenRef.current === runToken;

    const resolvePage = async (
      doc: PDFDocumentProxy,
      pageNumber: number,
      pageSize: DiffPageSize | null,
    ): Promise<{ page: PDFPageProxy; size: DiffPageSize } | null> => {
      const page = await doc.getPage(pageNumber);
      return isCurrent() ? { page, size: pageSizeOf(page, pageSize) } : null;
    };

    const renderSide = async (
      side: 'old' | 'new',
      page: PDFPageProxy,
      pageNumber: number,
      size: DiffPageSize,
      bitmap: PixelBitmapSize,
    ): Promise<CachedSide | null> => {
      const key = `${pageNumber}:${size.width}x${size.height}:${bitmap.width}x${bitmap.height}`;
      const cached = cache[side];
      if (cached && cached.key === key) return cached;

      const rect = pageDrawRect(size, bitmap);
      if (!rect) return null;

      const media = mediaBoxFor(page, size);
      const viewport = createMediaViewport(page.getViewport({ scale: rect.width / size.width }), media);

      const pageCanvas = document.createElement('canvas');
      pageCanvas.width = Math.max(1, Math.round(viewport.width));
      pageCanvas.height = Math.max(1, Math.round(viewport.height));
      const context = pageCanvas.getContext('2d');
      if (!context) return null;

      // Paper is white; the letterbox around a differently shaped page stays
      // clear so it is not compared as content.
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, pageCanvas.width, pageCanvas.height);

      const task = page.render({ canvasContext: context, viewport });
      tasks.push(task);
      await task.promise;
      if (!isCurrent()) return null;

      const entry: CachedSide = { key, canvas: pageCanvas, rect };
      cache[side] = entry;
      return entry;
    };

    const run = async (): Promise<void> => {
      setRendering(true);
      setRenderError(null);

      try {
        const oldResolved = oldReady
          ? await resolvePage(oldDoc, oldPageNumber, oldSize)
          : null;
        if (!isCurrent()) return;
        const newResolved = newReady
          ? await resolvePage(newDoc, newPageNumber, newSize)
          : null;
        if (!isCurrent()) return;

        const bitmap = fitBitmapSize(
          [oldResolved?.size ?? null, newResolved?.size ?? null],
          { maxDimension: MAX_PIXEL_BITMAP_DIMENSION },
        );
        if (!bitmap) {
          setBitmapSize(null);
          setRendering(false);
          notifyStats(null);
          return;
        }
        setBitmapSize((previous) =>
          previous && previous.width === bitmap.width && previous.height === bitmap.height
            ? previous
            : bitmap,
        );

        const oldSide = oldResolved
          ? await renderSide('old', oldResolved.page, oldPageNumber!, oldResolved.size, bitmap)
          : null;
        if (!isCurrent()) return;
        const newSide = newResolved
          ? await renderSide('new', newResolved.page, newPageNumber!, newResolved.size, bitmap)
          : null;
        if (!isCurrent()) return;

        const base = newSide ?? oldSide;
        if (!base) {
          setRendering(false);
          notifyStats(null);
          return;
        }

        // Regions are matched by page *and* projected through that side's own
        // draw rect, so a letterboxed page masks exactly the area the user drew.
        const regionRects: PixelDrawRect[] = [];
        for (const region of ignoreRegions ?? []) {
          if (oldSide && oldResolved && region.oldPage !== null && region.oldPage === oldPageNumber) {
            const rect = regionDrawRect(region.bbox, oldResolved.size, oldSide.rect);
            if (rect) regionRects.push(rect);
          }
          if (newSide && newResolved && region.newPage !== null && region.newPage === newPageNumber) {
            const rect = regionDrawRect(region.bbox, newResolved.size, newSide.rect);
            if (rect) regionRects.push(rect);
          }
        }
        const regionKey = JSON.stringify(
          regionRects.map((rect) => [
            Math.round(rect.x),
            Math.round(rect.y),
            Math.round(rect.width),
            Math.round(rect.height),
          ]),
        );

        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const context = canvas.getContext('2d');
        if (!context) return;
        context.setTransform(1, 0, 0, 1, 0, 0);
        context.clearRect(0, 0, bitmap.width, bitmap.height);
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, bitmap.width, bitmap.height);
        context.drawImage(base.canvas, base.rect.x, base.rect.y, base.rect.width, base.rect.height);

        if (style === 'blend' && oldSide && newSide) {
          context.globalAlpha = clampVisualOpacity(opacity);
          context.drawImage(
            oldSide.canvas,
            oldSide.rect.x,
            oldSide.rect.y,
            oldSide.rect.width,
            oldSide.rect.height,
          );
          context.globalAlpha = 1;
        }

        let diff: PixelDiffResult | null = null;
        if (oldSide && newSide) {
          const diffKey = `${oldSide.key}/${newSide.key}/${regionKey}`;
          if (cache.diff && cache.diffKey === diffKey) {
            diff = cache.diff;
          } else {
            const oldContext = oldSide.canvas.getContext('2d');
            const newContext = newSide.canvas.getContext('2d');
            if (oldContext && newContext) {
              diff = computePixelDiff(
                oldContext.getImageData(0, 0, bitmap.width, bitmap.height),
                newContext.getImageData(0, 0, bitmap.width, bitmap.height),
                {
                  threshold: DEFAULT_PIXEL_THRESHOLD,
                  maxDimension: MAX_PIXEL_BITMAP_DIMENSION,
                  isIgnored:
                    regionRects.length > 0
                      ? (x: number, y: number) =>
                          regionRects.some((rect) => drawRectContains(rect, x, y))
                      : undefined,
                },
              );
              cache.diff = diff;
              cache.diffKey = diffKey;
            }
          }
          if (diff && style === 'heatmap') drawMask(context, diff, bitmap);
        }

        overlay.width = bitmap.width;
        overlay.height = bitmap.height;
        const overlayContext = overlay.getContext('2d');
        if (overlayContext) {
          overlayContext.setTransform(1, 0, 0, 1, 0, 0);
          overlayContext.clearRect(0, 0, bitmap.width, bitmap.height);
          if (style === 'boxes') {
            for (const rect of diffBoxRects(boxes, bitmap.width, bitmap.height)) {
              overlayContext.globalAlpha = rect.selected ? 0.28 : 0.16;
              overlayContext.fillStyle = rect.color;
              overlayContext.fillRect(rect.x, rect.y, rect.width, rect.height);

              overlayContext.globalAlpha = 1;
              overlayContext.strokeStyle = rect.color;
              overlayContext.lineWidth = rect.selected ? 2.5 : 1.2;
              overlayContext.strokeRect(rect.x, rect.y, rect.width, rect.height);
            }
            overlayContext.globalAlpha = 1;
          }
          if (regionRects.length > 0) {
            drawRegionOutlines(overlayContext, regionRects);
          }
        }

        notifyStats(diff ? pixelDiffStats(diff) : null);
      } catch (err) {
        if (!isCurrent() || isRenderCancelled(err)) return;
        setRenderError(err instanceof Error ? err.message : 'Failed to render the pages');
        notifyStats(null);
      } finally {
        if (isCurrent()) setRendering(false);
      }
    };

    void run();

    return () => {
      cancelled = true;
      for (const task of tasks) task.cancel();
    };
  }, [
    boxes,
    ignoreRegions,
    newDoc,
    newPageNumber,
    newSize,
    notifyStats,
    oldDoc,
    oldPageNumber,
    oldSize,
    opacity,
    style,
  ]);

  // A new page starts at its top-left; the previous page's scroll offset would
  // otherwise open the next page clipped.
  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    scroll.scrollTop = 0;
    scroll.scrollLeft = 0;
  }, [oldPageNumber, newPageNumber, oldSource, newSource]);

  const loading = oldState.status === 'loading' || newState.status === 'loading';
  const loadError =
    oldState.status === 'error'
      ? `Failed to load the old document: ${oldState.error ?? 'unknown error'}`
      : newState.status === 'error'
        ? `Failed to load the new document: ${newState.error ?? 'unknown error'}`
        : null;

  const hasSource = Boolean(oldSource) || Boolean(newSource);
  const hasPage = oldPageNumber !== null || newPageNumber !== null;
  const oneSidedNotice =
    newPageNumber !== null && oldPageNumber === null
      ? 'This page exists only in the new document — showing the new page.'
      : oldPageNumber !== null && newPageNumber === null
        ? 'This page exists only in the old document — showing the old page.'
        : null;

  const pageLabel =
    oldPageNumber !== null && newPageNumber !== null
      ? `Old ${oldPageNumber} · New ${newPageNumber}`
      : newPageNumber !== null
        ? `New page ${newPageNumber}`
        : oldPageNumber !== null
          ? `Old page ${oldPageNumber}`
          : 'No page';

  // The canvas element must exist before the render effect can paint into it,
  // so it is mounted as soon as a page is addressable; until PDF.js reports the
  // shared bitmap the layout falls back to the contract's page size.
  const showCanvas = hasPage && hasSource && !loadError;
  const fallbackSize = newSize ?? oldSize;
  const layoutWidth = (bitmapSize?.width ?? fallbackSize?.width ?? 0) * zoom;
  const layoutHeight = (bitmapSize?.height ?? fallbackSize?.height ?? 0) * zoom;

  return (
    <section
      className={styles.pane}
      aria-label="Visual diff pane"
      data-testid="diff-visual-pane"
      data-style={style}
    >
      <header className={styles.header}>
        <span className={styles.badge}>Visual</span>
        <span className={styles.pageInfo}>{pageLabel}</span>
        <span className={styles.spacer} />
        {rendering && (
          <span className={styles.busy} role="status">
            Rendering pages…
          </span>
        )}
      </header>

      <div className={styles.scroll} ref={scrollRef}>
        {!hasSource && <p className={styles.state}>Choose two PDFs to compare.</p>}

        {loading && <p className={styles.state}>Loading documents…</p>}

        {loadError && (
          <p className={styles.error} role="alert">
            {loadError}
          </p>
        )}

        {oneSidedNotice && (
          <p className={styles.notice} role="status">
            {oneSidedNotice}
          </p>
        )}

        {!loading && !loadError && hasSource && !hasPage && (
          <p className={styles.state}>This page has no renderable side.</p>
        )}

        {showCanvas && (
          <div
            className={styles.page}
            data-testid="diff-visual-page"
            style={{
              width: layoutWidth > 0 ? layoutWidth : undefined,
              height: layoutHeight > 0 ? layoutHeight : undefined,
            }}
          >
            <canvas ref={canvasRef} className={styles.canvas} />
            <canvas ref={overlayRef} className={styles.overlay} aria-hidden="true" />
            {renderError && (
              <div className={styles.renderError} role="alert">
                {renderError}
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
};

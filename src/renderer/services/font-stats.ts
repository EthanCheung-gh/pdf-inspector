import type { FontStat } from '../types/ipc-protocol';

/**
 * Pages per font-analysis request.
 *
 * The sidecar analyzes a whole request synchronously, so asking for the entire
 * document at once starves the queue of `extract_page` calls. Small batches let
 * a page extraction slip in between two font batches.
 */
export const FONT_ANALYSIS_BATCH_SIZE = 10;

export interface FontBatchProgress {
  done: number;
  total: number;
}

/**
 * Format a PDF font size for display.
 *
 * pdfplumber sizes come from float arithmetic (`12.000000000000002`), so the raw
 * value must be rounded before it reaches the Fonts tab. Two decimals are enough
 * for the pt values PDFs use, and whole numbers stay whole (`12`, not `12.00`).
 */
export function formatFontSize(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const fixed = value.toFixed(2);
  if (!fixed.includes('.')) return fixed;
  return fixed.replace(/0+$/, '').replace(/\.$/, '');
}

function cloneStat(stat: FontStat): FontStat {
  return {
    fontname: stat.fontname,
    pages: [...stat.pages],
    charCount: stat.charCount,
    sizeMin: stat.sizeMin,
    sizeMax: stat.sizeMax,
    colors: [...stat.colors],
  };
}

function unionPages(a: number[], b: number[]): number[] {
  return [...new Set([...a, ...b])].sort((left, right) => left - right);
}

function unionColors(base: string[], added: string[]): string[] {
  const merged = [...base];
  for (const color of added) {
    if (!merged.includes(color)) merged.push(color);
  }
  return merged;
}

/**
 * Folds a batch of per-page-range font stats into the accumulated list.
 *
 * Stats are keyed by `fontname`: character counts add up, page and colour sets
 * are unioned (page order ascending, colour order first seen), and the size
 * range widens. The result is ordered by character count descending; the sort is
 * stable, so equally used fonts keep their first-seen order.
 *
 * Inputs are never mutated.
 */
export function mergeFontStats(base: FontStat[], batch: FontStat[]): FontStat[] {
  const merged = base.map(cloneStat);
  const byName = new Map<string, FontStat>();
  for (const stat of merged) byName.set(stat.fontname, stat);

  for (const stat of batch) {
    const existing = byName.get(stat.fontname);
    if (!existing) {
      const copy = cloneStat(stat);
      merged.push(copy);
      byName.set(copy.fontname, copy);
      continue;
    }

    existing.charCount += stat.charCount;
    existing.sizeMin = Math.min(existing.sizeMin, stat.sizeMin);
    existing.sizeMax = Math.max(existing.sizeMax, stat.sizeMax);
    existing.pages = unionPages(existing.pages, stat.pages);
    existing.colors = unionColors(existing.colors, stat.colors);
  }

  return merged.sort((left, right) => right.charCount - left.charCount);
}

export interface AnalyzeFontsInBatchesOptions {
  totalPages: number;
  batchSize?: number;
  fetchBatch(startPage: number, endPage: number): Promise<FontStat[]>;
  onProgress?(progress: FontBatchProgress): void;
  isCancelled?(): boolean;
}

/**
 * Walks the document in `batchSize` page ranges (1-based, inclusive) and merges
 * the results, reporting progress after every batch.
 *
 * Returns `null` when the caller cancels, so a cancelled run never publishes
 * partial results. Fetch errors propagate to the caller unchanged.
 */
export async function analyzeFontsInBatches(
  options: AnalyzeFontsInBatchesOptions,
): Promise<FontStat[] | null> {
  const { totalPages, fetchBatch, onProgress, isCancelled } = options;
  const batchSize =
    options.batchSize !== undefined && options.batchSize > 0
      ? Math.floor(options.batchSize)
      : FONT_ANALYSIS_BATCH_SIZE;
  const total = Number.isFinite(totalPages) ? Math.max(0, Math.floor(totalPages)) : 0;

  onProgress?.({ done: 0, total });
  if (total === 0) return [];

  let merged: FontStat[] = [];
  let done = 0;

  while (done < total) {
    if (isCancelled?.()) return null;

    const startPage = done + 1;
    const endPage = Math.min(done + batchSize, total);
    const batch = await fetchBatch(startPage, endPage);

    // Cancelled while the batch was in flight: drop the result entirely.
    if (isCancelled?.()) return null;

    merged = mergeFontStats(merged, batch);
    done = endPage;
    onProgress?.({ done, total });
  }

  return merged;
}

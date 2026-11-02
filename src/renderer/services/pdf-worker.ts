/**
 * One place that points PDF.js at its worker bundle.
 *
 * The Inspect viewport and the Diff panes each load documents through PDF.js;
 * without a worker PDF.js falls back to running everything on the main thread.
 * The assignment is idempotent so either view may load first, and it tolerates
 * a test double that stubs `pdfjs-dist` with an empty module.
 */
import * as pdfjsLib from 'pdfjs-dist';

let configured = false;

export function ensurePdfWorker(): void {
  if (configured) return;

  const options = pdfjsLib.GlobalWorkerOptions;
  if (!options) return;
  configured = true;

  options.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();
}

/**
 * PDF.js cancels a render task whenever a page/zoom change supersedes it. The
 * rejection is expected control flow, not an error: it must never be logged as
 * a failed render (the message includes the page number, e.g.
 * `Rendering cancelled, page 3`, and the class name is minified in production
 * builds, so both the name and the message prefix are checked).
 */
export function isRenderCancelled(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  const name = error.name.toLowerCase();
  const message = error.message.toLowerCase();
  return name.includes('renderingcancelled') || message.startsWith('rendering cancelled');
}

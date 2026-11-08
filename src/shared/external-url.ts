/**
 * External link validation shared by every process.
 *
 * The renderer, the Electron main process and the browser adapter all have to
 * agree on what "safe to hand to an OS/browser opener" means. Keeping one
 * implementation here means a link that the UI refuses to activate can never be
 * opened by a different code path, and it keeps the check available to the
 * composite node project (`main`/`preload`) without importing renderer files.
 *
 * Policy: only absolute `http:` / `https:` URLs pass. Relative targets, empty
 * strings, control characters and every other scheme (`javascript:`, `data:`,
 * `file:`, `mailto:`, `ftp:`, ...) are rejected. PDF.js exposes both a
 * sanitized `url` and a raw `unsafeUrl`; `unsafeUrl` is display-only and must
 * never be passed here as an activation target.
 */

/** Result of `openExternal` across preload, renderer and the web adapter. */
export interface OpenExternalResult {
  ok: boolean;
  error?: string;
}

/** Message used whenever a URL is refused before reaching an opener. */
export const UNSAFE_EXTERNAL_URL_ERROR = 'Only absolute http(s) links can be opened';

/** C0 control characters and DEL, which never belong in a URL. */
const CONTROL_CHAR = /[\u0000-\u001F\u007F]/;

/**
 * Return the trimmed URL when it may be opened, otherwise `null`.
 *
 * Every opener goes through this helper so the string that was validated is
 * exactly the string that gets opened.
 */
export function toSafeExternalUrl(url: unknown): string | null {
  if (typeof url !== 'string') return null;

  const trimmed = url.trim();
  if (trimmed.length === 0) return null;
  // Reject before parsing: `new URL()` silently strips some of these, which
  // would let `java\nscript:` style targets through as a different scheme.
  if (CONTROL_CHAR.test(trimmed)) return null;

  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? trimmed : null;
  } catch {
    return null;
  }
}

/** Whether `url` may be handed to an external opener. */
export function isSafeExternalUrl(url: unknown): boolean {
  return toSafeExternalUrl(url) !== null;
}

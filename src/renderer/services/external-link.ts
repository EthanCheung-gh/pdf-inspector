/**
 * The single entry point for activating a link found in a PDF.
 *
 * Two rules are enforced here, before any IPC happens:
 *
 * 1. Only absolute `http(s)` URLs are opened. PDF.js exposes a sanitized `url`
 *    and a raw `unsafeUrl`; callers may only ever pass the sanitized one, and it
 *    is validated again so a bad value can never reach the opener.
 * 2. Nothing opens automatically. This module is only called from an explicit
 *    user action ("Open link"), never from loading or rendering a page.
 *
 * Failures come back as `{ ok: false, error }` instead of a rejection: a
 * refused link or a missing handler is an expected, displayable outcome.
 */
import { ipc } from './ipc-client';
import {
  UNSAFE_EXTERNAL_URL_ERROR,
  toSafeExternalUrl,
} from '../../shared/external-url';
import type { OpenExternalResult } from '../../shared/external-url';

export { UNSAFE_EXTERNAL_URL_ERROR };
export type { OpenExternalResult };

/** Fallback message when the bridge fails without a usable reason. */
const OPEN_FAILED_ERROR = 'Could not open the link';

/**
 * Validate `url` and hand it to the platform opener.
 *
 * Returns `{ ok: true }` once the external opener accepted the URL, or
 * `{ ok: false, error }` when the URL is unsafe or the opener failed.
 */
export async function openExternalUrl(url: string | null): Promise<OpenExternalResult> {
  const safeUrl = toSafeExternalUrl(url);
  if (safeUrl === null) {
    return { ok: false, error: UNSAFE_EXTERNAL_URL_ERROR };
  }

  try {
    const result = await ipc.openExternal(safeUrl);
    if (!result || typeof result.ok !== 'boolean') {
      return { ok: false, error: OPEN_FAILED_ERROR };
    }
    if (result.ok) return { ok: true };
    return { ok: false, error: result.error ?? OPEN_FAILED_ERROR };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : OPEN_FAILED_ERROR,
    };
  }
}

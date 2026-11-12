import { useCallback } from 'react';
import { ipc } from '../services/ipc-client';
import { usePdfStore } from '../store/pdf-store';

/**
 * Navigate and extract a page while ensuring only the latest request for the
 * document that is still open can update page data, errors, or the loading
 * indicator.
 */
let latestNavigationRequestId = 0;

export function usePageNavigation() {
  const navigate = useCallback(async (page: number): Promise<void> => {
    // A page request is only meaningful for a known, loaded document: without a
    // usable page count (empty state, still opening, garbage) any number would
    // be sent to the sidecar and come back as "list index out of range".
    const startState = usePdfStore.getState();
    const { pageCount } = startState;
    if (!Number.isFinite(pageCount) || pageCount < 1) return;
    // `1.5`, `NaN` and `Infinity` are not page numbers; forwarding them makes the
    // sidecar index with a non-integer or a huge/negative offset.
    if (!Number.isInteger(page) || page < 1 || page > pageCount) return;

    const requestId = ++latestNavigationRequestId;
    // The document that owns this request. `setFile`/`resetDocument` bump the
    // epoch, which turns every response that arrives afterwards into a stale one.
    const startEpoch = startState.documentEpoch;

    startState.setError(null);
    startState.setLoading(true);
    startState.setPage(page);

    // Still the newest request AND still the same document. Checked after the
    // await as well as in `finally`, so a response for the document the user
    // already left can neither publish data nor clear the new document's
    // loading state nor report its (meaningless) out-of-range failure.
    const isCurrent = () =>
      requestId === latestNavigationRequestId &&
      usePdfStore.getState().documentEpoch === startEpoch;

    try {
      const data = await ipc.extractPage(page);
      if (isCurrent()) {
        usePdfStore.getState().setPageData(data);
      }
    } catch (error) {
      if (isCurrent()) {
        console.error('Failed to load page data:', error);
        // Surface the underlying message (a timeout, a restart, a sidecar
        // error) so a failed page is diagnosable from the UI; the generic
        // sentence is still used when the error carries no usable message.
        const message =
          error instanceof Error ? error.message.trim() : String(error ?? '').trim();
        // A message that already ends a sentence must not produce "..".
        const detail = message.replace(/[.\s]+$/, '');
        usePdfStore.getState().setError(
          detail
            ? `Failed to load page data: ${detail}. Please try again.`
            : 'Failed to load page data. Please try again.',
        );
      }
    } finally {
      if (isCurrent()) {
        usePdfStore.getState().setLoading(false);
      }
    }
  }, []);

  return { navigate };
}

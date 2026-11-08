import { useCallback } from 'react';
import { ipc } from '../services/ipc-client';
import { usePdfStore } from '../store/pdf-store';

/**
 * Navigate and extract a page while ensuring only the latest request can
 * update page data, errors, or the loading indicator.
 */
let latestNavigationRequestId = 0;

export function usePageNavigation() {
  const navigate = useCallback(async (page: number): Promise<void> => {
    const { pageCount } = usePdfStore.getState();
    if (page < 1 || page > pageCount) return;

    const requestId = ++latestNavigationRequestId;
    const store = usePdfStore.getState();
    store.setError(null);
    store.setLoading(true);
    store.setPage(page);

    try {
      const data = await ipc.extractPage(page);
      if (requestId === latestNavigationRequestId) {
        store.setPageData(data);
      }
    } catch (error) {
      if (requestId === latestNavigationRequestId) {
        console.error('Failed to load page data:', error);
        // Surface the underlying message (a timeout, a restart, a sidecar
        // error) so a failed page is diagnosable from the UI; the generic
        // sentence is still used when the error carries no usable message.
        const message =
          error instanceof Error ? error.message.trim() : String(error ?? '').trim();
        // A message that already ends a sentence must not produce "..".
        const detail = message.replace(/[.\s]+$/, '');
        store.setError(
          detail
            ? `Failed to load page data: ${detail}. Please try again.`
            : 'Failed to load page data. Please try again.',
        );
      }
    } finally {
      if (requestId === latestNavigationRequestId) {
        store.setLoading(false);
      }
    }
  }, []);

  return { navigate };
}

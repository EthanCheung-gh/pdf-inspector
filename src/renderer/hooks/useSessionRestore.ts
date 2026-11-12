import { useEffect, useRef } from 'react';
import { restoreSession } from '../services/session-restore';
import { usePageNavigation } from './usePageNavigation';

/**
 * Start the startup session restore once, after the first render.
 *
 * Mounted by `App` so the restore never blocks the first paint: the empty shell
 * renders immediately and the tabs stream in as documents open. All progress and
 * failures live in `session-restore-store`, which the status bar reads (Q3), so
 * this hook returns nothing and the engine never throws at the component.
 *
 * `startedRef` only spares redundant work inside one instance; the real
 * once-per-page-load guarantee is the engine's module-level guard, which also
 * covers React StrictMode's mount/unmount/mount cycle in development. For the
 * same reason the restore is deliberately not cancelled on unmount: StrictMode
 * runs the cleanup of the first mount while the one legitimate restore is still
 * in flight, and aborting there would make development builds restore nothing.
 */
export function useSessionRestore(): void {
  const { navigate } = usePageNavigation();
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void restoreSession({ navigate });
  }, [navigate]);
}

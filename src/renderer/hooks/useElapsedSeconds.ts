import { useEffect, useState } from 'react';

/** How often the elapsed counter refreshes; the display is whole seconds. */
const TICK_MS = 1_000;

/**
 * Whole seconds elapsed since `active` last became true.
 *
 * Purely informational: a long diff reports progress as pages complete, but the
 * UI has no trustworthy percentage (page pairing is only known after the
 * fingerprint pass), so it shows how long the comparison has been running
 * instead of inventing one. The counter resets to `0` as soon as `active` is
 * false, so re-entering a loading state never resumes a previous count.
 */
export function useElapsedSeconds(active: boolean): number {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!active) {
      setElapsed(0);
      return;
    }

    const startedAt = Date.now();
    setElapsed(0);
    const timer = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAt) / 1_000));
    }, TICK_MS);

    return () => clearInterval(timer);
  }, [active]);

  return elapsed;
}

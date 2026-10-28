import { describe, expect, it } from 'vitest';
import { resolveStartupPlan, shouldDeferQuit } from '../lifecycle';

describe('resolveStartupPlan', () => {
  it('packaged builds never probe system Python and use the bundled binary', () => {
    const plan = resolveStartupPlan({ isPackaged: true });
    expect(plan.probeSystemPython).toBe(false);
    expect(plan.sidecarRuntime).toBe('bundled-binary');
  });

  it('development builds probe system Python and run the script', () => {
    const plan = resolveStartupPlan({ isPackaged: false });
    expect(plan.probeSystemPython).toBe(true);
    expect(plan.sidecarRuntime).toBe('python-script');
  });
});

describe('shouldDeferQuit', () => {
  it('always defers on the first quit pass', () => {
    expect(shouldDeferQuit({ shutdownStarted: false })).toBe(true);
  });

  it('does not look at whether the sidecar is running (stop() must still run)', () => {
    // Regression: gating the defer on `isRunning()` skipped stop() when the
    // sidecar was already down, which left auto-restart enabled — a pending
    // crash-restart timer could then spawn a new sidecar after the user quit.
    expect(shouldDeferQuit({ shutdownStarted: false })).toBe(true);
  });

  it('does not defer on the re-issued quit, so the second pass proceeds', () => {
    expect(shouldDeferQuit({ shutdownStarted: true })).toBe(false);
  });
});

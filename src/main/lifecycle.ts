/**
 * Pure app-lifecycle decisions for the Electron main process.
 *
 * Kept free of `electron`, `fs` and child-process imports so the decisions can
 * be unit tested without an Electron binary or a real sidecar process.
 */

/** Which sidecar artifact a build is expected to spawn. */
export type SidecarRuntime = 'bundled-binary' | 'python-script';

export interface StartupPlan {
  /**
   * True only for development builds, where the sidecar is a Python script and
   * therefore needs a working system Python 3 interpreter.
   *
   * Packaged builds ship a PyInstaller-frozen binary and must NOT require
   * Python to be installed on the user's machine.
   */
  probeSystemPython: boolean;
  /** Sidecar artifact this build is expected to spawn. */
  sidecarRuntime: SidecarRuntime;
}

/** Decide what the app needs before it may start the sidecar. */
export function resolveStartupPlan(params: { isPackaged: boolean }): StartupPlan {
  if (params.isPackaged) {
    return { probeSystemPython: false, sidecarRuntime: 'bundled-binary' };
  }

  return { probeSystemPython: true, sidecarRuntime: 'python-script' };
}

export interface QuitState {
  /** True once a graceful shutdown has been kicked off for this quit cycle. */
  shutdownStarted: boolean;
}

/**
 * Whether `before-quit` must be deferred so the sidecar can be stopped first.
 *
 * Electron does not await async listeners, so the first quit is cancelled and
 * re-issued once `SidecarManager.stop()` has completed. The second pass sees
 * `shutdownStarted = true` and is allowed through.
 *
 * The decision intentionally does NOT depend on whether the sidecar looks
 * alive: `stop()` also disables auto-restart, so it must run even when the
 * process is already down — otherwise a crash-restart timer scheduled just
 * before the quit could spawn a fresh sidecar after the user quit.
 */
export function shouldDeferQuit(state: QuitState): boolean {
  return !state.shutdownStarted;
}

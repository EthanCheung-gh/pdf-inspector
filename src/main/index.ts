import { app, BrowserWindow, dialog } from 'electron';
import { execSync } from 'child_process';
import * as path from 'path';
import { SidecarManager } from './sidecar';
import { registerIpcHandlers } from './ipc-handlers';
import { cleanupDownloadedFiles } from './pdf-url';
import { getPythonCandidates, setSelectedPython } from '../shared/python-resolver';
import { resolveStartupPlan, shouldDeferQuit } from './lifecycle';

let mainWindow: BrowserWindow | null = null;
const sidecar = new SidecarManager();
/** Set once graceful shutdown begins so the re-issued quit passes through. */
let shutdownStarted = false;

function checkPythonAvailable(): boolean {
  for (const candidate of getPythonCandidates()) {
    try {
      const command = [candidate.command, ...candidate.args, '--version'].join(' ');
      execSync(command, { stdio: 'pipe' });
      setSelectedPython(candidate);
      return true;
    } catch {
      // Try the next candidate.
    }
  }

  return false;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 600,
    title: 'PDF Inspector',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../index.html'));
  }
}

app.whenReady().then(async () => {
  const startup = resolveStartupPlan({ isPackaged: app.isPackaged });

  // Packaged builds ship a frozen sidecar binary and must not require a system
  // Python installation; only development runs the Python script.
  if (startup.probeSystemPython && !checkPythonAvailable()) {
    await dialog.showMessageBox({
      type: 'error',
      title: 'Python Required',
      message: 'PDF Inspector requires Python 3.10+ to be installed.',
      detail: 'Please install Python 3 from https://python.org and ensure "python3" is in your PATH.\n\nThen install the required packages:\n  pip install pdfplumber Pillow',
    });
    app.quit();
    return;
  }

  registerIpcHandlers(sidecar);

  try {
    await sidecar.start();
    console.log('[main] Sidecar started');
  } catch (err) {
    console.error('[main] Failed to start sidecar:', err);
  }

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

/**
 * Electron does not await async `before-quit` listeners, so a graceful stop
 * has to be split across two quit events: cancel the first one, stop the
 * sidecar, then re-issue `app.quit()` with `shutdownStarted` set so the second
 * pass is allowed through.
 *
 * `stop()` runs even when the sidecar is not running: it is what disables
 * auto-restart, so skipping it would let a pending crash-restart timer spawn a
 * fresh sidecar after the user quit.
 */
app.on('before-quit', (event) => {
  if (!shouldDeferQuit({ shutdownStarted })) {
    return;
  }

  event.preventDefault();
  shutdownStarted = true;

  void sidecar
    .stop()
    .catch((err) => console.error('[main] Failed to stop sidecar:', err))
    // Only after the sidecar is gone: on Windows a file it still has open
    // cannot be deleted. Cleanup is best effort and never rejects.
    .then(() => cleanupDownloadedFiles())
    .catch((err) => console.error('[main] Failed to clean up downloaded files:', err))
    .finally(() => {
      app.quit();
    });
});

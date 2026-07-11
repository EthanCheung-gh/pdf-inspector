import { app, BrowserWindow, dialog } from 'electron';
import { execSync } from 'child_process';
import * as path from 'path';
import { SidecarManager } from './sidecar';
import { registerIpcHandlers } from './ipc-handlers';

let mainWindow: BrowserWindow | null = null;
const sidecar = new SidecarManager();

function checkPythonAvailable(): boolean {
  try {
    execSync('python3 --version', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
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
  if (!checkPythonAvailable()) {
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

app.on('before-quit', async () => {
  await sidecar.stop();
});

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('pdfInspector', {
  // Stub — will be populated in Task 6
  openPdf: () => ipcRenderer.invoke('pdf:open'),
});

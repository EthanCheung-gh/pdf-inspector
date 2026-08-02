export const SIDECAR_SCRIPT = 'sidecar/main.py';

/**
 * Request payload for the SAVE_FILE IPC channel. Defined here (not in
 * src/renderer/types) so the composite node tsconfig project
 * (main/preload) can import it without pulling renderer files in.
 */
export interface SaveFileRequest {
  defaultPath: string;
  content: string;
  filterName: string;
  extensions: string[];
}

export const IPC_CHANNELS = {
  OPEN_PDF: 'pdf:open',
  EXTRACT_PAGE: 'pdf:extract-page',
  EXTRACT_METADATA: 'pdf:extract-metadata',
  GET_IMAGE_DATA: 'pdf:get-image-data',
  SIDECAR_STATUS: 'pdf:sidecar-status',
  RESTART_SIDECAR: 'pdf:restart-sidecar',
  SAVE_FILE: 'file:save',
} as const;

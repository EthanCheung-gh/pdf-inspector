export const SIDECAR_SCRIPT = 'sidecar/main.py';
export const IPC_CHANNELS = {
  OPEN_PDF: 'pdf:open',
  EXTRACT_PAGE: 'pdf:extract-page',
  EXTRACT_METADATA: 'pdf:extract-metadata',
  GET_IMAGE_DATA: 'pdf:get-image-data',
  SIDECAR_STATUS: 'pdf:sidecar-status',
  RESTART_SIDECAR: 'pdf:restart-sidecar',
} as const;

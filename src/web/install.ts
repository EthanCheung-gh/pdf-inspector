/**
 * Side-effect module: install the browser `window.pdfInspector` bridge.
 *
 * Kept separate from `main.tsx` so the installation runs when this module is
 * evaluated - i.e. before any renderer module (and therefore before
 * `ReactDOM.render`). Import it first in `main.tsx`.
 */
import { installWebIpc } from './ipc-adapter';

installWebIpc();

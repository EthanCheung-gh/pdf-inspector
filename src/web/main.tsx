// Must stay first: this installs the browser implementation of
// `window.pdfInspector` while this module graph is evaluated, so the renderer
// never observes a missing bridge.
import './install';

import React from 'react';
import ReactDOM from 'react-dom/client';
import App from '@renderer/App';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

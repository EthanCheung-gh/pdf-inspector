// Must stay first: this installs the browser implementation of
// `window.pdfInspector` while this module graph is evaluated, so the renderer
// never observes a missing bridge.
import './install';

import '@renderer/theme.css';

import React from 'react';
import ReactDOM from 'react-dom/client';
import App from '@renderer/App';
import { initializeLocale } from '@renderer/i18n';
import { initializeTheme } from '@renderer/store/theme-store';

// Apply the persisted theme and locale before the first paint (see the desktop
// entry).
initializeTheme();
initializeLocale();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

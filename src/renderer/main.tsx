import './theme.css';

import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { initializeLocale } from './i18n';
import { initializeTheme } from './store/theme-store';

// Apply the persisted theme and locale before the first paint so an Islands /
// Chinese user never sees a flash of the default palette or an untranslated
// document language.
initializeTheme();
initializeLocale();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

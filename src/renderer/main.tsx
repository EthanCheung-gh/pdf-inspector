import './theme.css';

import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { initializeTheme } from './store/theme-store';

// Apply the persisted theme before the first paint so an Islands user never
// sees a flash of the dark palette.
initializeTheme();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

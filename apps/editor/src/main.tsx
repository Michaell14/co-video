import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import '@tandem/design/tokens.css';
import './styles/base.css';
import './styles/ui.css';
import './styles/app.css';
import './fonts';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Offline support: cache the app shell so the editor opens without a network. Production only —
// a service worker in front of the dev server would fight hot reloading.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL }).catch(() => {});
  });
}

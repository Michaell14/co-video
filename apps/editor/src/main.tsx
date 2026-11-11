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

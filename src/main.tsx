import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { StoreProvider } from './store.tsx';
import './styles.css';

/**
 * Pick a skin before the first paint so the window never flashes the wrong ground.
 * The server's saved skin arrives moments later and takes over.
 */
function bootTheme(): void {
  const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.dataset.skin = dark ? 'midnight' : 'white';
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
}

bootTheme();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <StoreProvider>
      <App />
    </StoreProvider>
  </StrictMode>,
);

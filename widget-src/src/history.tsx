import React from 'react';
import { createRoot } from 'react-dom/client';
import { HistoryPanel } from './components/HistoryPanel';
import { ErrorBoundary } from './components/ErrorBoundary';
import './styles.css';

function mount() {
  const container = document.getElementById('health-history-root');
  if (!container) {
    console.warn('Health history mount point not found');
    return;
  }

  const isLoggedIn = container.dataset.loggedIn === 'true';
  const loginUrl = container.dataset.loginUrl || undefined;

  const root = createRoot(container);
  root.render(
    <React.StrictMode>
      <ErrorBoundary>
        <HistoryPanel isLoggedIn={isLoggedIn} loginUrl={loginUrl} />
      </ErrorBoundary>
    </React.StrictMode>
  );
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mount);
} else {
  mount();
}

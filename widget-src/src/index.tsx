import React from 'react';
import { createRoot } from 'react-dom/client';
import { HealthTool } from './components/HealthTool';
import { ErrorBoundary } from './components/ErrorBoundary';
import './styles.css';

// Find the mount point in the Shopify theme
function mount() {
  const container = document.getElementById('health-tool-root');

  if (!container) {
    console.warn('Health tool mount point not found');
    return;
  }

  const root = createRoot(container);
  root.render(
    <React.StrictMode>
      <ErrorBoundary>
        <HealthTool />
      </ErrorBoundary>
    </React.StrictMode>
  );
}

// Mount when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mount);
} else {
  mount();
}

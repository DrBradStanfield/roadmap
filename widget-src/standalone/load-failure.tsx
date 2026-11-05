import { createRoot } from 'react-dom/client';
import { isStorageFailure } from '@roadmap/health-core';

/**
 * US-65 AC7: a record the app refuses at load (US-65 AC5), or any other
 * storage failure at load, is named on the page with its own words, in the
 * ErrorBoundary's markup, instead of the loading skeleton staying forever.
 * This never writes the record. Any other error renders nothing. The error is
 * thrown on, so main() still rejects as before.
 */
export function showLoadFailure(error: unknown): never {
  const container = document.getElementById('health-tool-root');
  if (container && isStorageFailure(error)) {
    createRoot(container).render(
      <div className="health-tool-error" role="alert">
        <h3>Your saved record could not be opened</h3>
        <p>{(error as Error).message}</p>
        <p style={{ marginTop: '8px', fontSize: '14px' }}>
          <a href="mailto:brad@drstanfield.com?subject=Health%20Roadmap%20Bug%20Report">Report this issue</a>
        </p>
      </div>,
    );
  }
  throw error;
}

import { createRoot } from 'react-dom/client';
import { isStorageFailure } from '@roadmap/health-core/sync-manager';
import { RecordShapeError, SchemaTooNewError } from '@roadmap/health-core/migrate';
import { StorageError } from '@roadmap/health-core/adapter';

/**
 * A record this build refuses (US-65 AC5): a newer schema, not a record, or
 * not JSON. The device copy's parse failure is the one `StorageError` whose
 * cause is a `SyntaxError` (local-storage-adapter.ts `readSync`).
 */
function isRefusal(error: unknown): boolean {
  return error instanceof SchemaTooNewError || error instanceof RecordShapeError
    || (error instanceof StorageError && error.cause instanceof SyntaxError);
}

const NEWER_SCHEMA_LINE = 'A newer version of Health by Dr Brad wrote this record. Reload the page to get that version. Nothing was written.';

/**
 * US-65 AC7: a record the app refuses at load (US-65 AC5), or any other
 * storage failure at load, is named on the page with its own words, in the
 * ErrorBoundary's markup, instead of the loading skeleton staying forever.
 * Only a refusal says the record could not be opened; any other storage
 * failure may pass, so it gets a neutral heading and a reload line.
 * This never writes the record. Any other error renders nothing. The error is
 * thrown on, so main() still rejects as before. A newer schema names a page
 * reload, as the iPhone names an app update (US-25 AC6b; #929). A connect that
 * failed on the way (US-09 AC1a) is said here too, or this panel hides it (#925).
 */
export function showLoadFailure(error: unknown, connectFailed?: string): never {
  const container = document.getElementById('health-tool-root');
  if (container && isStorageFailure(error)) {
    const refused = isRefusal(error);
    createRoot(container).render(
      <div className="health-tool-error" role="alert">
        <h3>{refused ? 'Your saved record could not be opened' : 'Your saved record did not load'}</h3>
        <p>{error instanceof SchemaTooNewError ? NEWER_SCHEMA_LINE : (error as Error).message}</p>
        {!refused && <p>Reload the page to try again.</p>}
        {connectFailed && <p>{connectFailed}</p>}
        <p style={{ marginTop: '8px', fontSize: '14px' }}>
          <a href="mailto:brad@drstanfield.com?subject=Health%20Roadmap%20Bug%20Report">Report this issue</a>
        </p>
      </div>,
    );
  }
  throw error;
}

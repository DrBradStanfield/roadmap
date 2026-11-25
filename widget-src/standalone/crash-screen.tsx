/**
 * US-11 AC14: the whole app's fallback after a render crash keeps "Delete all
 * my data" and the log-off within reach. Nothing here reads the tree that
 * crashed: the erase is the page's own entry point (useErase: its confirm,
 * its words, its report), run over the store; the log-off is the picker's
 * own step (LogOffConfirm), offered when the picker offers it (a connected
 * cloud that was read this session).
 */
import { useState } from 'react';
import { useErase } from '../src/hooks/useErase';
import { clearOffFileAfterErase } from '../src/lib/roadmap-data';
import { LogOffConfirm } from './backend-picker';
import { storageState, type Backend } from './connect';

const NOOP = (): void => {};

export function CrashScreen({ backend }: { backend: Backend }) {
  const cloud = backend !== 'local' && storageState(backend) === 'cloud' ? backend : null;
  const [loggingOff, setLoggingOff] = useState(false);
  // The page is gone, so its doors are: only the device's copy of the old record is forgotten.
  const { erasing, eraseAll } = useErase({ clearDrafts: NOOP, forget: clearOffFileAfterErase, reread: NOOP, shows: NOOP, spend: NOOP });
  // An erase that stands loads the page again, now on the erased record; one that did not leaves this screen.
  const erase = (): void => { void eraseAll().then(done => { if (done) location.reload(); }); };
  return (
    <div className="health-tool-error">
      <p>
        {cloud
          ? 'Something went wrong. Reload the page to try again. You can still delete your data or log off.'
          : 'Something went wrong. Reload the page to try again. You can still delete your data.'}
      </p>
      <div className="delete-data-section">
        <button className="delete-data-link" onClick={erase} disabled={erasing}>
          {erasing ? 'Deleting...' : 'Delete all my data'}
        </button>
      </div>
      {cloud && (loggingOff
        ? <LogOffConfirm current={cloud} />
        : (
          <div className="hr-modal-logoff">
            <button type="button" className="hr-sync-link" onClick={() => setLoggingOff(true)}>Log off this device</button>
          </div>
        ))}
      <p style={{ marginTop: '8px', fontSize: '14px' }}>
        <a href="mailto:brad@drstanfield.com?subject=Health%20Roadmap%20Bug%20Report">Report this issue</a>
      </p>
    </div>
  );
}

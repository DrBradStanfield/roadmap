/**
 * US-11 AC14: the whole app's fallback after a render crash keeps "Delete all
 * my data" and the log-off within reach. Nothing here reads the tree that
 * crashed: the erase is the page's own entry point (useErase: its confirm,
 * its words, its report), run over the store; the log-off is the picker's
 * own step (LogOffConfirm) and move (runMove, logOff), offered where the
 * picker offers it: a cloud whose sign-in is still held.
 */
import React, { useLayoutEffect, useReducer, useRef } from 'react';
import { ErrorBoundary } from '../src/components/ErrorBoundary';
import { useErase } from '../src/hooks/useErase';
import { clearOffFileAfterErase } from '../src/lib/roadmap-data';
import { LogOffConfirm } from './backend-picker';
import { logOff, storageState, type Backend } from './connect';
import { getSwitchFlow, runMove } from './switch-flow';

/** The screen's one mode: the erase and the log-off each lock the other out while it runs. */
export type CrashState =
  | { kind: 'idle'; focusTrigger: boolean }
  | { kind: 'erasing' }
  | { kind: 'confirmingLogOff'; error: string | null }
  | { kind: 'loggingOff' };

export type CrashEvent =
  | { type: 'erase-began' }
  | { type: 'erase-ended' }
  | { type: 'log-off-asked' }
  | { type: 'back' }
  | { type: 'log-off-began' }
  /** The move failed (its words) or was refused while another ran (null); one that worked reloads the page. */
  | { type: 'log-off-failed'; error: string | null };

export function transition(s: CrashState, e: CrashEvent): CrashState {
  switch (e.type) {
    case 'erase-began':
      return s.kind === 'idle' || s.kind === 'confirmingLogOff' ? { kind: 'erasing' } : s;
    case 'erase-ended':
      return s.kind === 'erasing' ? { kind: 'idle', focusTrigger: false } : s;
    case 'log-off-asked':
      return s.kind === 'idle' ? { kind: 'confirmingLogOff', error: null } : s;
    case 'back':
      return s.kind === 'confirmingLogOff' ? { kind: 'idle', focusTrigger: true } : s;
    case 'log-off-began':
      return s.kind === 'confirmingLogOff' ? { kind: 'loggingOff' } : s;
    case 'log-off-failed':
      return s.kind === 'loggingOff' ? { kind: 'confirmingLogOff', error: e.error } : s;
  }
}

const NOOP = (): void => {};
const IDLE: CrashState = { kind: 'idle', focusTrigger: false };

export function CrashScreen({ backend }: { backend: Backend }) {
  const cloud = backend !== 'local' && storageState(backend) === 'cloud' ? backend : null;
  const [state, dispatch] = useReducer(transition, IDLE);
  const trigger = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => { if (state.kind === 'idle' && state.focusTrigger) trigger.current?.focus(); }, [state]);
  // The page is gone, so its doors are: only the device's copy of the old record is forgotten.
  const { eraseAll } = useErase({ clearDrafts: NOOP, forget: clearOffFileAfterErase, reread: NOOP, shows: NOOP, spend: NOOP });

  // An erase that stands loads the page again, now on the erased record; one that did not leaves this screen.
  const erase = async (): Promise<void> => {
    dispatch({ type: 'erase-began' });
    if (await eraseAll()) location.reload();
    else dispatch({ type: 'erase-ended' });
  };
  const logOffHere = async (cloudBackend: Exclude<Backend, 'local'>): Promise<void> => {
    dispatch({ type: 'log-off-began' });
    await runMove({ type: 'logOff' }, () => logOff(cloudBackend));
    const flow = getSwitchFlow(); // a log-off that worked is reloading the page
    if (flow.kind !== 'idle' || flow.error) dispatch({ type: 'log-off-failed', error: flow.kind === 'idle' ? flow.error : null });
  };

  const busy = state.kind === 'erasing' || state.kind === 'loggingOff';
  return (
    <div className="health-tool-error">
      <p>
        {cloud
          ? 'Something went wrong. Reload the page to try again. You can still delete your data or log off.'
          : 'Something went wrong. Reload the page to try again. You can still delete your data.'}
      </p>
      <div className="delete-data-section">
        <button className="delete-data-link" onClick={() => void erase()} disabled={busy}>
          {state.kind === 'erasing' ? 'Deleting...' : 'Delete all my data'}
        </button>
      </div>
      {cloud && (state.kind === 'confirmingLogOff' || state.kind === 'loggingOff'
        ? (
          <>
            <LogOffConfirm
              current={cloud}
              busy={state.kind === 'loggingOff'}
              disabled={state.kind !== 'confirmingLogOff'}
              onBack={() => dispatch({ type: 'back' })}
              onLogOff={() => void logOffHere(cloud)}
            />
            {state.kind === 'confirmingLogOff' && state.error && <span className="hr-sync-error">{state.error}</span>}
          </>
        )
        : (
          <div className="hr-modal-logoff">
            <button ref={trigger} type="button" className="hr-sync-link" disabled={busy} onClick={() => dispatch({ type: 'log-off-asked' })}>
              Log off this device
            </button>
          </div>
        ))}
      <p style={{ marginTop: '8px', fontSize: '14px' }}>
        <a href="mailto:brad@drstanfield.com?subject=Health%20Roadmap%20Bug%20Report">Report this issue</a>
      </p>
    </div>
  );
}

/** The whole app's boundary: a crash shows CrashScreen, and a throw inside CrashScreen shows the static message. */
export function CrashBoundary({ backend, children }: { backend: Backend; children: React.ReactNode }) {
  return (
    <ErrorBoundary>
      <ErrorBoundary fallback={<CrashScreen backend={backend} />}>{children}</ErrorBoundary>
    </ErrorBoundary>
  );
}

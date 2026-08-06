/**
 * "Where should your health plan live?" lightbox — the one surface for choosing
 * or switching the storage backend (Brad's design call, 2026-06-10):
 *  - Neutral ordering, NO "recommended" badge (no pushing): Google Drive,
 *    Dropbox, then Advanced: GitHub, self-host. "Just this browser" last as the
 *    explicit no-wall escape hatch.
 *  - Switching while connected copies the current cloud's data down to this
 *    device first and drops the old connection's tokens (prepareSwitch), then
 *    the new connect lifts the data up — never stranded, nothing left behind.
 *  - On the website (Phase 5), this modal auto-opens once after the
 *    "Get Your Personalized Plan" email step by firing
 *    `window.dispatchEvent(new Event('hr:open-backend-picker'))` — the listener
 *    already lives in SyncControl.
 *  - Native <dialog>/showModal(): real focus trap + Escape + top-layer for
 *    free (converted pre-Phase-5, before the modal auto-opens on the website).
 */
import React, { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { GitHubAdapter, WebDavAdapter } from '../src/storage';
import { adapterFor, BACKEND_KEY, copyDownToDevice, finishFormConnect, logOff, PROVIDER_LABELS, useBusyRun, type Backend } from './connect';
import { trackProductEvent } from '../src/lib/api';
import { useModalDialog } from './use-dialog';

/* Minimal brand marks (Brad OK'd logos). Inline so no asset fetches. */
const LOGOS: Record<string, React.ReactNode> = {
  'google-drive': (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#0066DA" d="M8.16 1.5 0 15.6l3.84 6.9 8.16-14.1z" />
      <path fill="#00AC47" d="M15.84 1.5H8.16l8.16 14.1h7.68z" />
      <path fill="#FFBA00" d="M3.84 22.5h16.32L24 15.6H7.68z" />
    </svg>
  ),
  dropbox: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#0061FF"
        d="M6 1.8 0 5.6l6 3.8 6-3.8zm12 0-6 3.8 6 3.8 6-3.8zM0 13.2l6 3.8 6-3.8-6-3.8zm18-3.8-6 3.8 6 3.8 6-3.8zM6 18.3l6 3.9 6-3.9-6-3.8z"
      />
    </svg>
  ),
  github: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#181717"
        d="M12 .3a12 12 0 0 0-3.8 23.38c.6.12.83-.26.83-.57L9 21.07c-3.34.72-4.04-1.61-4.04-1.61-.55-1.39-1.34-1.76-1.34-1.76-1.08-.74.09-.73.09-.73 1.2.09 1.84 1.24 1.84 1.24 1.07 1.83 2.8 1.3 3.49 1 .1-.78.42-1.31.76-1.61-2.66-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.13-.3-.54-1.52.11-3.18 0 0 1-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.28-1.55 3.29-1.23 3.29-1.23.65 1.66.24 2.88.12 3.18.77.84 1.23 1.91 1.23 3.22 0 4.61-2.81 5.62-5.49 5.92.43.37.81 1.1.81 2.22l-.01 3.29c0 .31.21.7.83.57A12 12 0 0 0 12 .3" />
    </svg>
  ),
  'self-host': (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="2" y="3" width="20" height="8" rx="2" fill="none" stroke="#5a6b73" strokeWidth="2" />
      <rect x="2" y="13" width="20" height="8" rx="2" fill="none" stroke="#5a6b73" strokeWidth="2" />
      <circle cx="6.5" cy="7" r="1.4" fill="#5a6b73" />
      <circle cx="6.5" cy="17" r="1.4" fill="#5a6b73" />
    </svg>
  ),
  local: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3" y="4" width="18" height="12" rx="2" fill="none" stroke="#5a6b73" strokeWidth="2" />
      <path d="M9 20h6M12 16v4" stroke="#5a6b73" strokeWidth="2" strokeLinecap="round" />
    </svg>
  ),
};

interface Option {
  id: Backend;
  name: string;
  blurb: string;
  advanced?: boolean;
  local?: boolean;
}

const OPTIONS: Option[] = [
  {
    id: 'google-drive',
    name: 'Google Drive',
    blurb: "A private 'Health Plan by Dr Brad' folder in your Google Drive.",
  },
  {
    id: 'dropbox',
    name: 'Dropbox',
    blurb: "A private 'Health Plan by Dr Brad' folder in your Dropbox.",
  },
  {
    id: 'github',
    name: 'GitHub',
    blurb: 'A private GitHub repository you own — with full version history.',
    advanced: true,
  },
  {
    id: 'self-host',
    name: 'Your own server',
    blurb: 'Any WebDAV server you run (Nextcloud, ownCloud, …).',
    advanced: true,
  },
  {
    id: 'local',
    name: 'Just this browser',
    blurb: 'No account needed. Data stays on this device only.',
    local: true,
  },
];

export function BackendPickerModal({ current, onClose }: { current: Backend; onClose: () => void }) {
  const [step, setStep] = useState<'list' | 'github' | 'self-host' | 'log-off'>('list');
  const { busy, error, setError, run } = useBusyRun();
  const [gh, setGh] = useState({ token: '', owner: '', repo: '' });
  const [wd, setWd] = useState({ url: '', username: '', password: '' });
  const dialogRef = useModalDialog();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  /** Leaving a connected cloud: copy its data down, then drop its tokens. */
  const prepareSwitch = async (): Promise<void> => {
    if (current === 'local') return;
    await copyDownToDevice(current);
    await adapterFor(current)?.disconnect();
  };

  const choose = (id: Backend): void => {
    if (busy) return;
    if (id === current) {
      onClose();
      return;
    }
    if (id === 'github' || id === 'self-host') {
      setError(null);
      setStep(id);
      return;
    }
    void run(async () => {
      await prepareSwitch();
      if (id === 'local') {
        localStorage.removeItem(BACKEND_KEY);
        location.reload();
        return;
      }
      trackProductEvent('cloud_connect_started', { provider: id });
      // Full-page OAuth redirect — never resolves; completes in app.tsx on return.
      await adapterFor(id)!.connect();
    });
  };

  const submitForm = (id: 'github' | 'self-host'): void => {
    void run(async () => {
      await prepareSwitch();
      trackProductEvent('cloud_connect_started', { provider: id === 'self-host' ? 'webdav' : id });
      const adapter =
        id === 'github'
          ? new GitHubAdapter({ token: gh.token.trim(), owner: gh.owner.trim(), repo: gh.repo.trim() })
          : new WebDavAdapter({ url: wd.url.trim(), username: wd.username.trim(), password: wd.password });
      await finishFormConnect(adapter, id); // validates → migrates → reloads
    });
  };

  // Portal to <body>: the widget's panels sit inside transformed ancestors,
  // which re-anchor position:fixed to themselves — the modal would render
  // mid-page and scroll with it. Escaping to body keeps it viewport-centered.
  return createPortal(
    <dialog
      className="hr-modal"
      aria-label="Choose where to save your data"
      ref={dialogRef}
      onCancel={(e) => { e.preventDefault(); onCloseRef.current(); }}
      onClick={(e) => { if (e.target === e.currentTarget) onCloseRef.current(); }}
    >
      {/* Padding lives on the inner div so a ::backdrop click (which targets
          the dialog element itself) is distinguishable from a content click. */}
      <div className="hr-modal-inner">
        <button className="hr-modal-close" aria-label="Close" onClick={onClose}>×</button>

        {step === 'list' && (
          <>
            <h2>Where should your health plan live?</h2>
            <p className="hr-modal-sub">
              Your health data saves to a place <strong>you</strong> control — never to Dr Brad's servers.
            </p>
            {OPTIONS.map((o, i) => (
              <React.Fragment key={o.id}>
                {o.advanced && !OPTIONS[i - 1]?.advanced && <div className="hr-opt-divider">Advanced</div>}
                <button
                  className={`hr-opt${o.local ? ' hr-opt-local' : ''}`}
                  disabled={busy}
                  onClick={() => choose(o.id)}
                >
                  <span className="hr-opt-logo">{LOGOS[o.id]}</span>
                  <span className="hr-opt-text">
                    <span className="hr-opt-name">
                      {o.name}
                      {current === o.id && (
                        <span className="hr-opt-connected">✓ {o.local ? 'Current' : 'Connected'}</span>
                      )}
                    </span>
                    <span className="hr-opt-blurb">{o.blurb}</span>
                  </span>
                </button>
              </React.Fragment>
            ))}
            {current !== 'local' && (
              <div className="hr-modal-logoff">
                <button type="button" className="hr-sync-link" disabled={busy} onClick={() => { setError(null); setStep('log-off'); }}>
                  Log off this device
                </button>
              </div>
            )}
          </>
        )}

        {step === 'log-off' && current !== 'local' && (
          <>
            <button className="hr-modal-back" onClick={() => setStep('list')}>← Back</button>
            <h2>Log off this device?</h2>
            <p className="hr-modal-sub">
              Your data stays safe in your {PROVIDER_LABELS[current]} — this just signs you out and
              clears your health plan from this device. Sign back in with the same account to
              restore everything.
            </p>
            <div className="hr-sync-form">
              <button className="hr-sync-btn" disabled={busy} onClick={() => void run(() => logOff(current))}>
                {busy ? 'Logging off…' : 'Log off'}
              </button>
            </div>
          </>
        )}

        {step === 'github' && (
          <>
            <button className="hr-modal-back" onClick={() => setStep('list')}>← Back</button>
            <h2>Connect GitHub</h2>
            <p className="hr-modal-sub">
              Create a private repository, then a fine-grained token scoped to just that repository
              (Contents: read &amp; write).
            </p>
            <div className="hr-sync-form">
              <input type="password" placeholder="Fine-grained token (one repo, Contents read+write)" value={gh.token} onChange={(e) => setGh({ ...gh, token: e.target.value })} />
              <input placeholder="Owner (your GitHub user or org)" value={gh.owner} onChange={(e) => setGh({ ...gh, owner: e.target.value })} />
              <input placeholder="Repository name" value={gh.repo} onChange={(e) => setGh({ ...gh, repo: e.target.value })} />
              <button className="hr-sync-btn" disabled={busy || !gh.token || !gh.owner || !gh.repo} onClick={() => submitForm('github')}>
                {busy ? 'Connecting…' : 'Connect GitHub'}
              </button>
            </div>
          </>
        )}

        {step === 'self-host' && (
          <>
            <button className="hr-modal-back" onClick={() => setStep('list')}>← Back</button>
            <h2>Connect your own server</h2>
            <p className="hr-modal-sub">Point at any WebDAV folder you control. Needs CORS enabled for this site.</p>
            <div className="hr-sync-form">
              <input placeholder="WebDAV folder URL (https://…)" value={wd.url} onChange={(e) => setWd({ ...wd, url: e.target.value })} />
              <input placeholder="Username" value={wd.username} onChange={(e) => setWd({ ...wd, username: e.target.value })} />
              <input type="password" placeholder="Password / app password" value={wd.password} onChange={(e) => setWd({ ...wd, password: e.target.value })} />
              <button className="hr-sync-btn" disabled={busy || !wd.url || !wd.username} onClick={() => submitForm('self-host')}>
                {busy ? 'Connecting…' : 'Connect'}
              </button>
            </div>
          </>
        )}

        {error && <span className="hr-sync-error">{error}</span>}
      </div>
    </dialog>,
    document.body,
  );
}

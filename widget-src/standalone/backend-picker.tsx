/**
 * "Where should your health plan live?" lightbox — the one surface for choosing
 * or switching the storage backend (Brad's design call, 2026-06-10):
 *  - Neutral ordering, NO "recommended" badge (no pushing): Google Drive,
 *    Dropbox, then Advanced: GitHub, self-host. "Just this browser" last as the
 *    explicit no-wall escape hatch.
 *  - Switching while connected copies the current cloud's data down to this
 *    device first (copyDownToDevice), then the new connect lifts it up — data
 *    is never stranded.
 *  - On the website (Phase 5), this modal auto-opens once after the
 *    "Get Your Personalized Plan" email step by firing
 *    `window.dispatchEvent(new Event('hr:open-backend-picker'))` — the listener
 *    already lives in SyncControl.
 */
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { DropboxAdapter, GoogleDriveAdapter, GitHubAdapter, WebDavAdapter } from '../src/storage';
import { dropboxConfig } from './dropbox-config';
import { googleDriveConfig } from './google-config';
import { BACKEND_KEY, copyDownToDevice, finishFormConnect, type Backend } from './connect';

/* Minimal brand marks (Brad OK'd logos). 20px viewBoxes, inline so no asset fetches. */
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
];

export function BackendPickerModal({ current, onClose }: { current: Backend; onClose: () => void }) {
  const [step, setStep] = useState<'list' | 'github' | 'self-host'>('list');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gh, setGh] = useState({ token: '', owner: '', repo: '' });
  const [wd, setWd] = useState({ url: '', username: '', password: '' });
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    dialogRef.current?.focus();
    // Lock background scrolling while the modal is open.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  const run = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await fn(); // success ends in a navigation or reload
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Connection failed.');
      setBusy(false);
    }
  };

  /** Cloud-to-anything switches copy the current cloud down to this device first. */
  const prepareSwitch = async (): Promise<void> => {
    if (current !== 'local') await copyDownToDevice(current);
  };

  const choose = (id: Backend): void => {
    if (busy) return;
    if (id === current) {
      onClose();
      return;
    }
    if (id === 'google-drive' || id === 'dropbox') {
      void run(async () => {
        await prepareSwitch();
        // Full-page OAuth redirect — never resolves; completes in app.tsx on return.
        if (id === 'google-drive') await new GoogleDriveAdapter(googleDriveConfig()).connect();
        else await new DropboxAdapter(dropboxConfig()).connect();
      });
      return;
    }
    if (id === 'github' || id === 'self-host') {
      setError(null);
      setStep(id);
      return;
    }
    // 'local' — keep data on this device only.
    void run(async () => {
      await prepareSwitch();
      localStorage.removeItem(BACKEND_KEY);
      location.reload();
    });
  };

  const submitForm = (id: 'github' | 'self-host'): void => {
    void run(async () => {
      await prepareSwitch();
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
    <div className="hr-modal-overlay" onClick={onClose}>
      <div
        className="hr-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Choose where to save your data"
        tabIndex={-1}
        ref={dialogRef}
        onClick={(e) => e.stopPropagation()}
      >
        <button className="hr-modal-close" aria-label="Close" onClick={onClose}>×</button>

        {step === 'list' && (
          <>
            <h2>Where should your health plan live?</h2>
            <p className="hr-modal-sub">
              Your data saves to a place <strong>you</strong> control — never to our servers.
            </p>
            {OPTIONS.filter((o) => !o.advanced).map((o) => (
              <button key={o.id} className="hr-opt" disabled={busy} onClick={() => choose(o.id)}>
                <span className="hr-opt-logo">{LOGOS[o.id]}</span>
                <span className="hr-opt-text">
                  <span className="hr-opt-name">
                    {o.name}
                    {current === o.id && <span className="hr-opt-connected">✓ Connected</span>}
                  </span>
                  <span className="hr-opt-blurb">{o.blurb}</span>
                </span>
              </button>
            ))}
            <div className="hr-opt-divider">Advanced</div>
            {OPTIONS.filter((o) => o.advanced).map((o) => (
              <button key={o.id} className="hr-opt" disabled={busy} onClick={() => choose(o.id)}>
                <span className="hr-opt-logo">{LOGOS[o.id]}</span>
                <span className="hr-opt-text">
                  <span className="hr-opt-name">
                    {o.name}
                    {current === o.id && <span className="hr-opt-connected">✓ Connected</span>}
                  </span>
                  <span className="hr-opt-blurb">{o.blurb}</span>
                </span>
              </button>
            ))}
            <button className="hr-opt hr-opt-local" disabled={busy} onClick={() => choose('local')}>
              <span className="hr-opt-logo">{LOGOS.local}</span>
              <span className="hr-opt-text">
                <span className="hr-opt-name">
                  Just this browser
                  {current === 'local' && <span className="hr-opt-connected">✓ Current</span>}
                </span>
                <span className="hr-opt-blurb">No account needed. Data stays on this device only.</span>
              </span>
            </button>
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
    </div>,
    document.body,
  );
}

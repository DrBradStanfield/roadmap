/**
 * Connect-a-cloud control for the standalone build (Phase 2). Shows the real
 * sync status (replacing HealthTool's Shopify account indicator) and lets the
 * user move between the on-device tier and a cloud backend:
 *   - Dropbox — one-click OAuth (redirect; completed in app.tsx on return)
 *   - GitHub — pasted fine-grained PAT (one repo)
 *   - Self-host — a WebDAV server the user controls
 * GitHub + self-host validate their pasted credentials in place via
 * finishFormConnect (connect.ts), which lifts on-device data up and reloads.
 */
import React, { useState } from 'react';
import {
  DropboxAdapter,
  GoogleDriveAdapter,
  GitHubAdapter,
  WebDavAdapter,
  LocalStorageAdapter,
  SyncManager,
  getDeviceId,
  type StorageAdapter,
} from '../src/storage';
import { dropboxConfig } from './dropbox-config';
import { googleDriveConfig } from './google-config';
import { BACKEND_KEY, finishFormConnect, type Backend } from './connect';

const LABELS: Record<Exclude<Backend, 'local'>, string> = {
  dropbox: 'Dropbox',
  'google-drive': 'Google Drive',
  github: 'GitHub',
  'self-host': 'your own server',
};

/** The adapter for a currently-connected backend (used for the disconnect read-down). */
function adapterFor(backend: Backend): StorageAdapter | null {
  switch (backend) {
    case 'dropbox':
      return new DropboxAdapter(dropboxConfig());
    case 'google-drive':
      return new GoogleDriveAdapter(googleDriveConfig());
    case 'github':
      return new GitHubAdapter();
    case 'self-host':
      return new WebDavAdapter();
    default:
      return null;
  }
}

export function SyncControl({ backend, reconnect }: { backend: Backend; reconnect?: 'google-drive' }) {
  const [openForm, setOpenForm] = useState<'github' | 'webdav' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gh, setGh] = useState({ token: '', owner: '', repo: '' });
  const [wd, setWd] = useState({ url: '', username: '', password: '' });

  const connectDropbox = (): void => {
    void new DropboxAdapter(dropboxConfig()).connect(); // navigates to Dropbox OAuth
  };

  const submit = async (adapter: StorageAdapter, id: Backend): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await finishFormConnect(adapter, id); // validates → migrates → reloads
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Connection failed.');
      setBusy(false); // on success the page reloads, so we only reach here on failure
    }
  };

  const disconnect = async (): Promise<void> => {
    try {
      const adapter = adapterFor(backend);
      if (adapter) {
        // Copy the latest cloud data down to this device so nothing appears lost.
        const { file } = await adapter.read();
        if (file) await new SyncManager(new LocalStorageAdapter(), getDeviceId()).save(file);
        await adapter.disconnect();
      }
    } catch (e) {
      console.warn('Disconnect failed', e);
    }
    localStorage.removeItem(BACKEND_KEY);
    location.reload();
  };

  if (backend !== 'local') {
    return (
      <div className="hr-sync hr-sync-dropbox">
        <span className="hr-sync-status">✓ Synced to {LABELS[backend]}</span>
        <button className="hr-sync-link" onClick={() => void disconnect()}>Use this device only</button>
        <span className="hr-sync-detail">Your data lives only in {LABELS[backend]} — never on our servers.</span>
      </div>
    );
  }

  // Forget the pending Google Drive connection (no copy-down needed — this
  // session is already running on the device copy; the Drive file stays put).
  const forgetDrive = async (): Promise<void> => {
    await new GoogleDriveAdapter(googleDriveConfig()).disconnect();
    localStorage.removeItem(BACKEND_KEY);
    location.reload();
  };

  // Google Drive is remembered but its short-lived token is gone (new tab /
  // >1h). Re-auth needs a user click (browsers block popups at page load).
  if (reconnect === 'google-drive') {
    return (
      <div className="hr-sync hr-sync-local">
        <span className="hr-sync-status">Google Drive — signed out</span>
        <button className="hr-sync-btn" disabled={busy}
          onClick={() => void submit(new GoogleDriveAdapter(googleDriveConfig()), 'google-drive')}>
          {busy ? 'Reconnecting…' : 'Reconnect Google Drive'}
        </button>
        <span className="hr-sync-detail">
          Your data is safe in your Google Drive. Sign in again to keep syncing — anything you change
          meanwhile is saved on this device and merges when you reconnect.
        </span>
        <div className="hr-sync-more">
          <button type="button" className="hr-sync-link" onClick={() => void forgetDrive()}>Use this device only</button>
        </div>
        {error && <span className="hr-sync-error">{error}</span>}
      </div>
    );
  }

  return (
    <div className="hr-sync hr-sync-local">
      <span className="hr-sync-status">Saved on this device</span>
      <button className="hr-sync-btn" onClick={connectDropbox} disabled={busy}>Connect Dropbox</button>
      <span className="hr-sync-detail">Your data is only in this browser. Connect a cloud to sync across your phone and computer.</span>

      <div className="hr-sync-more">
        {openForm === null ? (
          <button type="button" className="hr-sync-link" onClick={() => setOpenForm('github')}>More ways to sync ▾</button>
        ) : (
          <div className="hr-sync-forms">
            <button className="hr-sync-btn" disabled={busy}
              onClick={() => void submit(new GoogleDriveAdapter(googleDriveConfig()), 'google-drive')}>
              {busy ? 'Connecting…' : 'Connect Google Drive'}
            </button>
            <div className="hr-sync-tabs">
              <button type="button" className={openForm === 'github' ? 'on' : ''} onClick={() => { setOpenForm('github'); setError(null); }}>GitHub</button>
              <button type="button" className={openForm === 'webdav' ? 'on' : ''} onClick={() => { setOpenForm('webdav'); setError(null); }}>Self-host (WebDAV)</button>
            </div>

            {openForm === 'github' && (
              <div className="hr-sync-form">
                <input type="password" placeholder="Fine-grained token (one repo, Contents read+write)" value={gh.token} onChange={(e) => setGh({ ...gh, token: e.target.value })} />
                <input placeholder="Owner (your GitHub user or org)" value={gh.owner} onChange={(e) => setGh({ ...gh, owner: e.target.value })} />
                <input placeholder="Repository name" value={gh.repo} onChange={(e) => setGh({ ...gh, repo: e.target.value })} />
                <button className="hr-sync-btn" disabled={busy || !gh.token || !gh.owner || !gh.repo}
                  onClick={() => void submit(new GitHubAdapter({ token: gh.token.trim(), owner: gh.owner.trim(), repo: gh.repo.trim() }), 'github')}>
                  {busy ? 'Connecting…' : 'Connect GitHub'}
                </button>
              </div>
            )}

            {openForm === 'webdav' && (
              <div className="hr-sync-form">
                <input placeholder="WebDAV folder URL (https://…)" value={wd.url} onChange={(e) => setWd({ ...wd, url: e.target.value })} />
                <input placeholder="Username" value={wd.username} onChange={(e) => setWd({ ...wd, username: e.target.value })} />
                <input type="password" placeholder="Password / app password" value={wd.password} onChange={(e) => setWd({ ...wd, password: e.target.value })} />
                <button className="hr-sync-btn" disabled={busy || !wd.url || !wd.username}
                  onClick={() => void submit(new WebDavAdapter({ url: wd.url.trim(), username: wd.username.trim(), password: wd.password }), 'self-host')}>
                  {busy ? 'Connecting…' : 'Connect'}
                </button>
              </div>
            )}
          </div>
        )}
        {error && <span className="hr-sync-error">{error}</span>}
      </div>
    </div>
  );
}

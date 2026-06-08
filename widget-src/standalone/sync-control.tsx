/**
 * Phase 2 connect-a-cloud control for the standalone build. Shows the real
 * sync status (replacing HealthTool's Shopify "Logged in · Data synced"
 * indicator, which is hidden on standalone) and lets the user move between the
 * on-device tier and Dropbox.
 *
 * Connect: redirects to Dropbox OAuth; on return, app.tsx lifts the on-device
 * data into Dropbox (migrateLocalInto) so nothing is lost. Disconnect: copies
 * the Dropbox data back down to this device first, then drops the connection.
 *
 * More backends (Google Drive, GitHub, self-host) slot in here as they land.
 */
import React from 'react';
import { DropboxAdapter, LocalStorageAdapter, SyncManager, getDeviceId } from '../src/storage';
import { dropboxConfig } from './dropbox-config';

export type Backend = 'dropbox' | 'local';
export const BACKEND_KEY = 'health_roadmap_backend';

export function SyncControl({ backend }: { backend: Backend }) {
  const connect = (): void => {
    void new DropboxAdapter(dropboxConfig()).connect(); // navigates to Dropbox OAuth
  };

  const disconnect = async (): Promise<void> => {
    try {
      // Copy the latest Dropbox data down to this device so nothing appears lost.
      const dbx = new DropboxAdapter(dropboxConfig());
      const { file } = await dbx.read();
      if (file) {
        await new SyncManager(new LocalStorageAdapter(), getDeviceId()).save(file);
      }
      await dbx.disconnect();
    } catch (error) {
      console.warn('Dropbox disconnect failed', error);
    }
    localStorage.removeItem(BACKEND_KEY);
    location.reload();
  };

  if (backend === 'dropbox') {
    return (
      <div className="hr-sync hr-sync-dropbox">
        <span className="hr-sync-status">✓ Synced to your Dropbox</span>
        <span className="hr-sync-detail">Your data lives in your own <code>Apps/Dr&nbsp;Brad</code> folder — not on our servers.</span>
        <button className="hr-sync-link" onClick={() => void disconnect()}>Use this device only</button>
      </div>
    );
  }

  return (
    <div className="hr-sync hr-sync-local">
      <span className="hr-sync-status">Saved on this device</span>
      <span className="hr-sync-detail">Your data is only in this browser. Connect a cloud to sync across your phone and computer.</span>
      <button className="hr-sync-btn" onClick={connect}>Connect Dropbox</button>
    </div>
  );
}

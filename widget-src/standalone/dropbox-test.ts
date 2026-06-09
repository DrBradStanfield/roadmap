/**
 * Phase-0/1 live Dropbox verification for the GitHub Pages harness. Connects to
 * the user's own Dropbox (App-folder scoped) via the real DropboxAdapter +
 * SyncManager and round-trips a record: load → add a measurement → save →
 * reload → verify it's there. This is the definitive proof that the cloud
 * adapter + optimistic-concurrency write path work end-to-end.
 *
 * The app key is a PKCE client id — public by design (it appears in the OAuth
 * URL the user sees), so it is safe in this public repo.
 */
import { createMeasurement, type FileMeasurement } from '@roadmap/health-core';
import { DropboxAdapter, getDeviceId, StorageError, SyncManager } from '../src/storage';

const DROPBOX_APP_KEY = 'xf96vqvjotm5xhx';

interface Els {
  status: HTMLElement;
  actions: HTMLElement;
  result: HTMLElement;
}

export async function initDropboxTest(els: Els): Promise<void> {
  const config = { clientId: DROPBOX_APP_KEY, redirectUri: location.origin + location.pathname };

  // If we're returning from the OAuth redirect, finish the handshake.
  let adapter: DropboxAdapter | null = null;
  try {
    adapter = await DropboxAdapter.completeRedirect(config);
  } catch (error) {
    els.result.textContent = `Sign-in error: ${(error as Error).message}`;
  }
  if (!adapter) {
    const existing = new DropboxAdapter(config);
    if (existing.isConnected()) adapter = existing;
  }

  function addButton(label: string, onClick: () => void | Promise<void>): void {
    const button = document.createElement('button');
    button.textContent = label;
    button.addEventListener('click', () => void onClick());
    els.actions.appendChild(button);
  }

  function render(): void {
    els.actions.innerHTML = '';
    if (adapter?.isConnected()) {
      els.status.innerHTML = '<strong style="color:#1a7f55">Connected ✓</strong> — your Dropbox App folder';
      addButton('Run round-trip', runRoundTrip);
      addButton('Disconnect', disconnect);
    } else {
      els.status.textContent = 'Not connected.';
      addButton('Connect Dropbox', () => (adapter ?? new DropboxAdapter(config)).connect());
    }
  }

  async function disconnect(): Promise<void> {
    if (adapter) await adapter.disconnect();
    adapter = null;
    els.result.textContent = '';
    render();
  }

  async function runRoundTrip(): Promise<void> {
    if (!adapter) return;
    els.result.textContent = 'Running…';
    try {
      const sync = new SyncManager(adapter, getDeviceId());
      const before = await sync.load();
      const beforeActive = countActive(before.measurements);
      const measurement = createMeasurement({
        id: `dbx_test_${before.meta.lamport + 1}`,
        metricType: 'ldl',
        value: 2.1,
        recordedAt: new Date().toISOString().slice(0, 10),
        createdAt: new Date().toISOString(),
      });
      before.measurements.push(measurement);
      const saved = await sync.save(before);
      const reloaded = await sync.load();
      const present = reloaded.measurements.some((m) => m.id === measurement.id);
      els.result.textContent = [
        present ? '✓ PASS — wrote to Dropbox and read it back' : '✗ FAIL — record not found after reload',
        `wrote: ${measurement.id} (ldl 2.1)`,
        `dropbox rev: ${saved.version}`,
        `active measurements: ${beforeActive} → ${countActive(reloaded.measurements)}`,
        `schema v${reloaded.schemaVersion} · lamport ${reloaded.meta.lamport}`,
        'file: /Apps/Health Plan by Dr Brad/health-roadmap.json',
      ].join('\n');
    } catch (error) {
      const message = error instanceof StorageError ? error.message : (error as Error).message;
      els.result.textContent = `✗ Round-trip error: ${message}`;
    }
  }

  render();
}

function countActive(measurements: FileMeasurement[]): number {
  return measurements.filter((m) => m.status === 'active').length;
}

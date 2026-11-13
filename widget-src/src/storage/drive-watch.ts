/**
 * Google Drive's change signal (US-34): the loop GoogleDriveAdapter.watch runs.
 * Moved out of drive.ts unchanged (lead A3); the adapter passes a host that
 * exposes only what the loop reads.
 */
import { ROADMAP_FILE_NAME, sleepUntilAborted, catchUpAfterFailure, StorageError, jsonBody } from '@roadmap/health-core/adapter';
import { DRIVE_API } from '@roadmap/health-core/drive-rest';
import { isSignedOut } from './sign-in-state';

/** What the loop reads from the adapter, and nothing more. */
export interface DriveWatchHost {
  /** The record's copies as the last read or write found them. */
  readonly recordIds: ReadonlySet<string>;
  cachedFileId(fileName: string): string | undefined;
  authHeaders(): Promise<Record<string, string>>;
  /** Rethrows a failed call's error, noting a refused access token first (US-09 AC48). */
  refused(error: unknown): never;
}

/** Drive has no long-poll for a browser (its push channels need a public
 *  webhook), so the change signal is its changes feed, read on a short beat
 *  while the tab is visible. Three seconds is a page that keeps up without
 *  spending a request a second. */
const CHANGES_POLL_MS = 3_000;
/** First retry after a failed changes read, doubling to this ceiling. */
const RETRY_MIN_MS = 3_000;
const RETRY_MAX_MS = 60_000;

/** One page of Drive's changes feed — the fields the watch asks for. */
interface DriveChangesPage {
  newStartPageToken?: string;
  nextPageToken?: string;
  changes?: { fileId?: string }[];
}

export async function driveWatchLoop(host: DriveWatchHost, fileName: string, onChange: () => void, signal: AbortSignal): Promise<void> {
  let retryMs = 0;
  // The outer loop owns the page token: a failure drops it, and the next
  // turn asks Drive for a fresh one. A sign-in this page knows has ended stops it
  // until a reload: no request can succeed (US-09 AC48).
  while (!signal.aborted && !isSignedOut('google-drive')) {
    try {
      let token = await startPageToken(host, signal);
      catchUpAfterFailure(retryMs, signal, onChange);
      while (!signal.aborted && !isSignedOut('google-drive')) { // the raise stops an established watch too (Codex R2)
        const url = `${DRIVE_API}/changes?pageToken=${encodeURIComponent(token)}&pageSize=100`
          + '&fields=newStartPageToken,nextPageToken,changes(fileId)';
        const page: DriveChangesPage = await jsonBody(await changesRequest(host, url, signal));
        // The record's copies as the last read or write found them, never
        // only a cached id, which may name a losing copy (US-10 AC4a).
        const ours = [...(fileName === ROADMAP_FILE_NAME ? host.recordIds : []), host.cachedFileId(fileName)].filter(Boolean);
        if (page.changes?.some((c) => !ours.length || ours.includes(c.fileId)) && !signal.aborted) onChange();
        // `nextPageToken` means more pages of the SAME batch: take it and
        // read again on the next beat rather than looping the pages here,
        // because the answer is already "something changed".
        token = page.nextPageToken ?? page.newStartPageToken ?? token;
        retryMs = 0;
        await sleepUntilAborted(CHANGES_POLL_MS, signal);
      }
    } catch {
      // An expired token, a 401 the refresh could not fix, a dead network:
      // wait longer each time, then start over from a fresh page token.
      retryMs = Math.min(retryMs ? retryMs * 2 : RETRY_MIN_MS, RETRY_MAX_MS);
      await sleepUntilAborted(retryMs, signal);
    }
  }
}

async function startPageToken(host: DriveWatchHost, signal: AbortSignal): Promise<string> {
  const res = await changesRequest(host, `${DRIVE_API}/changes/startPageToken`, signal);
  const json = await jsonBody<{ startPageToken?: string }>(res);
  if (!json.startPageToken) throw new StorageError('Google Drive returned no start page token.');
  return json.startPageToken;
}

async function changesRequest(host: DriveWatchHost, url: string, signal: AbortSignal): Promise<Response> {
  const res = await fetch(url, { headers: await host.authHeaders(), signal });
  if (!res.ok) host.refused(new StorageError(`Google Drive watch failed (${res.status}).`, undefined, undefined, res.status));
  return res;
}

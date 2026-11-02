/**
 * US-09 AC13f: a Dropbox record upload that goes out and gets no answer may
 * have landed, so the failure says so, as GitHub and WebDAV saves already do
 * (AC13d). The hosted connector prints this hint to the assistant
 * (`describeStorageFailure`, mcp.server.ts), which used to be told to "Try
 * once more" about a change that was already in the file.
 * Covered: the 30-second-style lost answer through SyncManager, a caller's own
 * deadline, and a first save with no version yet (`mode: add`).
 * Real DropboxAdapter and SyncManager; synthetic HTTP only, no live provider.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DropboxAdapter } from './dropbox-rest';
import { ROADMAP_DOC } from './roadmap-doc';
import { SyncManager, describeStorageFailure } from './sync-manager';
import { createEmptyFile } from './roadmap-file';

const empty = () => createEmptyFile({ deviceId: 'synthetic-device', now: '2026-01-01T00:00:00Z' });

/** Downloads answer with the stored record; the upload is stored, then its
 *  answer is lost (a socket severed after the request went out). */
function dropbox(opts: { uploadAnswers: boolean; downloadAnswers?: boolean }) {
  let stored = JSON.stringify(empty());
  let rev = 1;
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push(url);
    if (url.endsWith('/files/upload')) {
      stored = String(init.body);
      rev++;
      if (!opts.uploadAnswers) throw new TypeError('terminated');
      return new Response(JSON.stringify({ rev: `r${rev}` }), { status: 200 });
    }
    if (opts.downloadAnswers === false) throw new TypeError('fetch failed');
    return new Response(stored, { status: 200, headers: { 'dropbox-api-result': JSON.stringify({ rev: `r${rev}` }) } });
  }));
  return { calls };
}

async function saveFailure() {
  const sync = new SyncManager(new DropboxAdapter('synthetic-token'), 'synthetic-device', ROADMAP_DOC, { now: () => '2026-01-02T00:00:00Z' });
  const error = await sync.save(empty()).then(() => null, (e: unknown) => e);
  expect(error).not.toBeNull();
  return describeStorageFailure(error, 'The record in Dropbox');
}

describe('US-09 AC13f: a Dropbox record save that gets no answer', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('says the change may have landed, not to try once more', async () => {
    const box = dropbox({ uploadAnswers: false });
    const failure = await saveFailure();
    expect(box.calls.some((url) => url.endsWith('/files/upload'))).toBe(true);
    expect(failure.hint).toBe('The change may have landed. Read the record again before trying it a second time.');
    expect(failure.hint).not.toMatch(/try once more/i);
  });

  it('a read that gets no answer still says nothing was written', async () => {
    const box = dropbox({ uploadAnswers: true, downloadAnswers: false });
    const failure = await saveFailure();
    expect(box.calls.some((url) => url.endsWith('/files/upload'))).toBe(false);
    expect(failure.hint).toBe('Try once more; if it keeps failing, check that the record is reachable.');
  });

  it("a caller's own deadline that aborts the sent upload also says it may have landed", async () => {
    let uploaded = false;
    vi.stubGlobal('fetch', vi.fn((url: string, init: RequestInit = {}) => {
      if (!url.endsWith('/files/upload')) return Promise.reject(new Error(`unexpected ${url}`));
      uploaded = true;
      // The upload went out; no answer comes before the caller gives up.
      return new Promise<Response>((_, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    }));
    const deadline = new AbortController();
    const write = new DropboxAdapter('synthetic-token')
      .write(ROADMAP_DOC.fileName, empty(), 'r1', deadline.signal)
      .then(() => null, (e: unknown) => e);
    await vi.waitFor(() => expect(uploaded).toBe(true));
    deadline.abort();
    const failure = describeStorageFailure(await write, 'The record in Dropbox');
    expect(failure.hint).toBe('The change may have landed. Read the record again before trying it a second time.');
  });

  it('a first save to an empty Dropbox (no version yet) that gets no answer also says it may have landed', async () => {
    const modes: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
      if (!url.endsWith('/files/upload')) throw new Error(`unexpected ${url}`);
      const arg = JSON.parse(String((init.headers as Record<string, string>)['Dropbox-API-Arg']));
      modes.push(arg.mode['.tag']);
      throw new TypeError('terminated');
    }));
    const error = await new DropboxAdapter('synthetic-token')
      .write(ROADMAP_DOC.fileName, empty(), null)
      .then(() => null, (e: unknown) => e);
    expect(modes).toEqual(['add']);
    const failure = describeStorageFailure(error, 'The record in Dropbox');
    expect(failure.hint).toBe('The change may have landed. Read the record again before trying it a second time.');
  });
});

// PR 1848 Codex: a Save is held to the cloud session it was asked of. One queued on session A while
// A closes and B opens in its place (at the same erase identity) refuses not-open, and nothing of it
// lands in B. The window is too narrow for the bundled fake cloud (closing A stops its writes, so the
// queue drains before B opens), so `./cloud` is a stand-in here whose open session the test swaps.
import { describe, expect, it, vi } from 'vitest';
import { createEmptyFile } from '../../packages/health-core/src/roadmap-file';
import { NO_CHOICES } from '../../packages/health-core/src/upload-choices';

const NOW = '2026-10-21T08:00:00.000Z';
const cloud = vi.hoisted(() => ({ open: null as unknown, commits: [] as unknown[] }));
vi.mock('./cloud', () => ({
  get open() { return cloud.open; },
  NOT_OPEN: 'The cloud record is not open.',
  ERASED: 'Your record was erased on another device, so this was not saved.',
  commit: (at: unknown, file: unknown) => { cloud.commits.push([at, file]); return null; },
}));
const { oneDocumentSaveAtATime } = await import('./cloud-documents');
const { uploadSaveRun } = await import('./upload-save-door');

/** A session as the door reads it: its record, its erase and a store that counts puts. */
function session(name: string) {
  const puts: string[] = [];
  const file = createEmptyFile({ deviceId: name, now: NOW });
  return { puts, at: { session: { file, refuses: () => false, eraseIdentity: '[0,null]' }, host: { store: { writeDocument: async (ref: string) => void puts.push(ref) } } } };
}
const letter = { classification: 'clinic_letter', reportDate: null, values: [], additionalValues: [], unrecognized: [], document: { classification: 'clinic_letter', title: 'Synthetic letter', documentDate: '2026-09-14', contentMarkdown: '# Letter', metadata: {} } };
const STATE = JSON.stringify({ phase: 'saving', platform: 'phone', run: 1, started: NOW, firstRead: NOW, attempt: 1,
  files: [{ id: 'other', name: 'other.pdf', bytes: 1, hash: 'sha256-other', pages: { count: 1, truncated: false }, status: { s: 'read', extraction: letter, choices: NO_CHOICES } }] });

describe('a queued Save is held to the session it was asked of (PR 1848 Codex)', () => {
  it('A closes and B opens at the same erase while it waits: not-open, nothing put, nothing committed to B', async () => {
    const a = session('a');
    const b = session('b');
    cloud.open = a.at;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const holding = oneDocumentSaveAtATime(() => gate.then(() => '{}'));
    const queued = uploadSaveRun(STATE, '', '[0,null]', NOW, 'phone', JSON.stringify({ other: 'application/pdf' }), () => new Uint8Array([1]).buffer);
    cloud.open = b.at; // A closed, B opened in its place
    release();
    await holding;
    expect(JSON.parse(await queued)).toMatchObject({ ok: false, reason: 'not-open' });
    expect(b.puts).toEqual([]);
    expect(cloud.commits).toEqual([]);
  });
});

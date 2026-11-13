// @vitest-environment jsdom
/**
 * US-11 AC6 — the matrix drafts and the owner rule. Every page that takes an
 * erase in drops the draft it has on screen, so nothing typed before the erase
 * commits into the erased record. Only the page on the record this browser has
 * chosen writes or removes the shared draft key; another page keeps what it
 * types on screen only. This page is the test's own module graph; each other
 * tab is a fresh one. Synthetic values; in-memory cloud; no network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import type { ApiMeasurement } from '@roadmap/health-core/mappings';
import { MemoryCloud } from '@roadmap/health-core/memory-adapter';
import { RecordSession } from '@roadmap/health-core/record-session';
import { createMeasurement } from '@roadmap/health-core/roadmap-file';
import type { Refused, SaveTask } from './matrix-save';
import { StartingInfoVitals } from '../components/StartingInfoVitals';
import { VITALS_DRAFT_KEY } from './storage';
import { LocalStorageAdapter } from '../storage/local-storage-adapter';
import { BACKEND_KEY, webRecordHost } from '../storage/web-record-host';
import { press, typeInto } from '../testing/matrix-gestures';

vi.mock('./sentry', () => ({ Sentry: { captureException: vi.fn() } }));

const THEIRS = JSON.stringify({ draft: { values: { weight: '79' } }, backfills: {}, meta: {} });
const later = () => vi.setSystemTime(Date.now() + 60_000);
const add = (session: { edit: RecordSession['edit'] }, id: string) =>
  session.edit((file) => void file.measurements.push(createMeasurement({
    id, metricType: 'weight', value: 80, recordedAt: '2026-11-12', createdAt: '2026-11-12T10:00:00.000Z',
  })));

/** Another tab: a fresh module graph, with its own health-write state. */
async function otherTab() {
  vi.resetModules();
  const { RecordSession: TabSession } = await import('@roadmap/health-core/record-session');
  const { webRecordHost: tabHost } = await import('../storage/web-record-host');
  const { MemoryAdapter } = await import('@roadmap/health-core/memory-adapter');
  return { openCloud: (cloud: MemoryCloud) => TabSession.open(tabHost(new MemoryAdapter(cloud))) };
}

/** A cloud record erased earlier, from a tab on that cloud, before this page opens. */
async function erasedCloud(): Promise<MemoryCloud> {
  const cloud = new MemoryCloud();
  localStorage.setItem(BACKEND_KEY, 'memory');
  const earlier = await (await otherTab()).openCloud(cloud);
  add(earlier, 'old');
  await earlier.flush();
  expect((await earlier.erase()).success).toBe(true);
  localStorage.clear();
  return cloud;
}

/** The vitals matrix on this page, with a button outside it. */
function vitals() {
  const history: ApiMeasurement[] = [{
    id: 'sys1', metricType: 'systolic_bp', value: 120,
    recordedAt: '2026-09-01T00:00:00.000Z', createdAt: '2026-09-01T00:00:00.000Z', status: 'active',
  }];
  const onSave = vi.fn<(tasks: SaveTask[]) => Promise<Refused>>().mockResolvedValue(new Map());
  const view = render(<div>
    <StartingInfoVitals vitalsHistory={history} unitSystem="si" onSave={onSave} formStage={3}
      plan={null} unitOverrides={{}} onToggleFieldUnit={() => {}}/>
    <button>elsewhere</button>
  </div>);
  const row = Array.from(view.container.querySelectorAll<HTMLElement>('.bt-row'))
    .find((r) => r.querySelector('.bt-name-label')?.textContent === 'Weight')!;
  return {
    weight: row.querySelector<HTMLElement>('.bt-cell-draft')!.querySelector('input')!,
    elsewhere: view.getByText('elsewhere'),
    onSave,
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-12T10:00:00.000Z'));
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  localStorage.clear();
});

describe('US-11 AC6 — matrix drafts belong to the record this browser has chosen', () => {
  it('a guest page off the chosen record takes an erase in: its draft leaves the screen, nothing commits on leaving, and the other record\'s draft stays', async () => {
    const cloud = await erasedCloud();
    const guest = await RecordSession.open(webRecordHost(new LocalStorageAdapter()));
    const m = vitals();
    typeInto(m.weight, '80');
    // Another tab signs in to the erased cloud, types its own draft, saves and hides.
    localStorage.setItem(BACKEND_KEY, 'memory');
    const signedIn = await (await otherTab()).openCloud(cloud);
    localStorage.setItem(VITALS_DRAFT_KEY, THEIRS);
    add(signedIn, 'new');
    signedIn.flushSync();

    later();
    await act(async () => { await guest.refreshFromRemote(); });

    expect(guest.eraseIdentity).toBe(signedIn.eraseIdentity); // taken in
    expect(m.weight.value).toBe('');
    press(m.elsewhere);
    await act(async () => {});
    expect(m.onSave.mock.calls.every(([tasks]) => tasks.length === 0)).toBe(true);
    expect(localStorage.getItem(VITALS_DRAFT_KEY)).toBe(THEIRS);
  });

  it('a guest page typing after another tab signed in writes no draft and removes none', async () => {
    await RecordSession.open(webRecordHost(new LocalStorageAdapter()));
    const m = vitals();
    localStorage.setItem(BACKEND_KEY, 'memory'); // another tab signs in and types
    localStorage.setItem(VITALS_DRAFT_KEY, THEIRS);

    typeInto(m.weight, '81');
    expect(m.weight.value).toBe('81'); // on screen
    expect(localStorage.getItem(VITALS_DRAFT_KEY)).toBe(THEIRS);
    typeInto(m.weight, '');
    expect(localStorage.getItem(VITALS_DRAFT_KEY)).toBe(THEIRS);
  });

  it('control: the page on the chosen record keeps its draft on the device, and its erase clears it', async () => {
    const guest = await RecordSession.open(webRecordHost(new LocalStorageAdapter()));
    add(guest, 'mine');
    await guest.flush();
    const m = vitals();

    typeInto(m.weight, '82');
    expect(JSON.parse(localStorage.getItem(VITALS_DRAFT_KEY)!).draft.values).toEqual({ weight: '82' });

    await act(async () => { expect((await guest.erase()).success).toBe(true); });
    expect(localStorage.getItem(VITALS_DRAFT_KEY)).toBeNull();
    expect(m.weight.value).toBe('');
  });
});

// @vitest-environment jsdom
/**
 * US-74 AC8, the single-topic widgets' entry: once per page however many
 * blocks load the script (review U1), a loading line while the record opens,
 * and a failure panel in every block, with no doctor's name or address, when
 * it does not (review U4, U5).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, waitFor } from '@testing-library/react';
import { SchemaTooNewError, migrateFile } from '@roadmap/health-core/migrate';
import { MemoryAdapter, MemoryCloud } from '@roadmap/health-core/memory-adapter';
import { ROADMAP_FILE_NAME } from '@roadmap/health-core/adapter';
import { rowRootIds } from '@roadmap/health-core/merge';
import { CURRENT_SCHEMA_VERSION } from '@roadmap/health-core/roadmap-file';
import { RoadmapStore } from '../src/storage/roadmap-store';
import * as data from '../src/lib/roadmap-data';
import { trackProductEvent } from '../src/lib/server-api';

const boot = vi.hoisted(() => vi.fn());
vi.mock('./boot', () => ({ boot }));
vi.mock('./resolve-backend', () => ({ resolveBackend: vi.fn() }));
vi.mock('./page-departure', () => ({ registerPageDeparture: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../src/lib/server-api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/server-api')>(),
  trackProductEvent: vi.fn(),
}));
const widget = vi.hoisted(() => ({ throws: false }));
vi.mock('../src/widgets/router', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/widgets/router')>();
  const Throwing = () => { throw new Error('render broke'); };
  return { widgetFor: (name: string | undefined) => (widget.throws && name === 'waist-to-height' ? Throwing : real.widgetFor(name)) };
});

import { startWidgets } from './widgets';

const STARTED = Symbol.for('health-widgets.started');
const block = (topic = 'waist-to-height') => `<div class="hr-widget" data-widget="${topic}">&nbsp;</div>`;
const blocks = () => [...document.querySelectorAll<HTMLElement>('.hr-widget')];
const DOCTOR = /Dr Brad|drstanfield|Stanfield|mailto/i;

beforeEach(() => {
  delete (window as unknown as Record<symbol, unknown>)[STARTED];
  boot.mockReset();
  widget.throws = false;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('single-topic widget entry (US-74)', () => {
  it('U1: two blocks open the record once and mount once each, with their own ids, however often the script runs', async () => {
    boot.mockResolvedValue({ backend: 'local' });
    document.body.innerHTML = block() + block();
    await act(async () => { await Promise.all([startWidgets(), startWidgets()]); });
    await act(async () => { await startWidgets(); });
    expect(boot).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(document.querySelectorAll('form.hr-widget-form')).toHaveLength(2));
    const ids = [...document.querySelectorAll('[id]')].map((el) => el.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('U4: each block shows a loading line while the record opens', async () => {
    let open!: () => void;
    boot.mockReturnValue(new Promise<void>((resolve) => { open = resolve; }));
    document.body.innerHTML = block() + block();
    let started!: Promise<void>;
    await act(async () => { started = startWidgets(); });
    for (const el of blocks()) expect(el.textContent).toBe('Loading…');
    await act(async () => { open(); await started; });
    for (const el of blocks()) expect(el.querySelector('form')).not.toBeNull();
  });

  it.each([
    ['a non-storage error', new TypeError('x is undefined')],
    ['a newer record', new SchemaTooNewError(99, 1)],
  ])('U4 and U5: %s at boot puts the failure panel in every block, with no doctor, and no rejection', async (_name, error) => {
    boot.mockRejectedValue(error);
    document.body.innerHTML = block() + block();
    await act(async () => { await expect(startWidgets()).resolves.toBeUndefined(); });
    for (const el of blocks()) {
      expect(el.querySelector('[role="alert"] h3')?.textContent).toMatch(/^Your saved record (did not load|could not be opened)$/);
      expect(el.innerHTML).not.toMatch(DOCTOR);
    }
  });

  it('U5: a widget that throws while rendering shows the brand-neutral panel, not the full app\'s', async () => {
    boot.mockResolvedValue({ backend: 'local' });
    widget.throws = true;
    document.body.innerHTML = block();
    await act(async () => { await startWidgets(); });
    await waitFor(() => expect(blocks()[0].querySelector('[role="alert"]')).not.toBeNull());
    expect(blocks()[0].innerHTML).not.toMatch(DOCTOR);
  });

  it('a page with no known topic opens nothing', async () => {
    document.body.innerHTML = block('not-a-topic');
    await act(async () => { await startWidgets(); });
    expect(boot).not.toHaveBeenCalled();
    expect(blocks()[0].innerHTML).toBe('&nbsp;');
  });
});

// US-75 AC8 with US-74 and US-75 AC1's usage signal: a start-over after a newer erase is the same page view, so it
// sends no second viewed event and no second saved event. Counted as deltas: StrictMode's dev double mount at the
// start is not what is checked here.
describe('the widgets page follows a newer erase within one page view', () => {
  it('a re-read brings an erase: no second viewed event, and a save after it sends no second saved event', async () => {
    let store!: RoadmapStore;
    vi.spyOn(RoadmapStore.prototype, 'startLiveRefresh').mockImplementation(function (this: RoadmapStore) { store = this; return () => {}; });
    localStorage.setItem('health_roadmap_backend', 'memory');
    const cloud = new MemoryCloud();
    await data.initRoadmapStore(new MemoryAdapter(cloud));
    boot.mockResolvedValue({ backend: 'memory' });
    vi.mocked(trackProductEvent).mockClear();
    document.body.innerHTML = block('blood-pressure') + block('waist-to-height');
    await act(async () => { await startWidgets(); });
    const count = (name: string) => vi.mocked(trackProductEvent).mock.calls.filter(([n]) => n === name).length;
    const reading = () => document.querySelector('.hr-widget[data-widget="blood-pressure"] fieldset')!;
    const enterPair = async (sys: string, dia: string) => {
      const [top, bottom] = [...reading().querySelectorAll<HTMLInputElement>('input')];
      fireEvent.change(top, { target: { value: sys } });
      fireEvent.change(bottom, { target: { value: dia } });
      fireEvent.keyDown(bottom, { key: 'Enter' });
      await act(async () => { await new Promise((r) => setTimeout(r, 30)); await data.flushRoadmapStore(); });
    };
    await enterPair('128', '82');
    const viewed = { bp: count('bp_widget_viewed'), waist: count('waist_widget_viewed') };
    expect(count('bp_widget_saved')).toBe(1);

    // Another device erases the record in the cloud, as its deleteUserData writes it; this page hears by its re-read.
    const adapter = new MemoryAdapter(cloud);
    const { body, version } = await adapter.read(ROADMAP_FILE_NAME);
    const now = new Date(Date.now() + 1000).toISOString();
    const prior = migrateFile(body, { deviceId: 'other-device', now });
    const erased = migrateFile(null, { deviceId: 'other-device', now });
    const epoch = (prior.meta.eraseEpoch ?? 0) + 1;
    erased.schemaVersion = CURRENT_SCHEMA_VERSION;
    erased.erasedRows = { fromEpoch: epoch, ids: [...new Set(rowRootIds(prior))].sort() };
    erased.meta.eraseEpoch = epoch;
    erased.meta.erasedAt = now;
    await adapter.write(ROADMAP_FILE_NAME, erased, version);
    const before = data.getShownErase();
    await act(async () => { await store.refreshFromRemote(); });
    expect(data.getShownErase()).not.toBe(before); // the page followed the erase and started over
    expect(reading().querySelector('input')!.value).toBe('');

    await enterPair('130', '84');
    expect(count('bp_widget_viewed')).toBe(viewed.bp);
    expect(count('waist_widget_viewed')).toBe(viewed.waist);
    expect(count('bp_widget_saved')).toBe(1);
  });
});

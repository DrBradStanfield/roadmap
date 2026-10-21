/**
 * US-11 AC6 (orchestrator O5, 2026-10-21): an erase made on another device
 * clears the same off-file health data here as an erase made here (AC1),
 * stored document blobs included, by a re-read or by a save. Before, the
 * remote path cleared only the drafts and the Lp(a) kept answers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryAdapter, MemoryCloud } from '@roadmap/health-core';
import { RoadmapStore } from './roadmap-store';

vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));

const OFF_FILE: Record<string, string> = {
  health_roadmap_bt_timeline_draft: '{"draft":{"date":"2026-09-01","values":{"ldl":"3.2"}}}',
  health_roadmap_vitals_draft: '{"draft":{"date":"2026-09-01","values":{"weight":"82"}}}',
  health_roadmap_lpa_check_kept: '["row-1"]',
  'health_roadmap_doc_v2:scan-123': 'data:application/pdf;base64,AAAA',
};
/** Keys an erase must not touch (connection, consent, the typed key). */
const KEEP: Record<string, string> = {
  health_roadmap_dropbox_tokens: '{"access_token":"secret"}',
  health_roadmap_backend: 'dropbox',
  health_roadmap_device_id: 'device-1',
  hr_anthropic_key: 'sk-ant-typed-by-the-user',
};

/** Stored keys are own enumerable props, so the erase's prefix sweep sees them. */
function makeStorage(): Storage {
  const s = {} as Record<string, string>;
  Object.defineProperties(s, {
    length: { get() { return Object.keys(this).length; } },
    getItem: { value(k: string) { return k in this ? this[k] : null; } },
    setItem: { value(k: string, v: string) { this[k] = String(v); } },
    removeItem: { value(k: string) { delete this[k]; } },
    clear: { value() { for (const k of Object.keys(this)) delete this[k]; } },
    key: { value(i: number) { return Object.keys(this)[i] ?? null; } },
  });
  return s as unknown as Storage;
}

/** One localStorage stands for every device, so this device's
 *  off-file data goes back after the other device's erase cleared it. */
const putBack = () => { for (const [k, v] of Object.entries(OFF_FILE)) localStorage.setItem(k, v); };

describe('an erase made on another device clears every off-file kind here (US-11 AC6, O5)', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'localStorage', { value: makeStorage(), writable: true, configurable: true });
    for (const [k, v] of Object.entries(KEEP)) localStorage.setItem(k, v);
    vi.stubGlobal('window', new EventTarget());
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-21T10:00:00.000Z'));
  });
  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'localStorage');
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  async function erasedElsewhere() {
    const cloud = new MemoryCloud();
    const page = await RoadmapStore.create(new MemoryAdapter(cloud));
    page.addMeasurement('weight', 80, '2024-01-01T00:00:00.000Z');
    await page.flush();
    const otherPage = await RoadmapStore.create(new MemoryAdapter(cloud));
    vi.setSystemTime(new Date('2026-10-21T10:01:00.000Z'));
    expect((await (await RoadmapStore.create(new MemoryAdapter(cloud))).deleteUserData()).success).toBe(true);
    putBack();
    return { page, otherPage };
  }

  it('by a re-read', async () => {
    const { page } = await erasedElsewhere();
    expect(await page.refreshFromRemote()).toBe(true);
    for (const k of Object.keys(OFF_FILE)) expect(localStorage.getItem(k), k).toBeNull();
    for (const [k, v] of Object.entries(KEEP)) expect(localStorage.getItem(k)).toBe(v);
  });

  it('by a save', async () => {
    const { otherPage } = await erasedElsewhere();
    vi.setSystemTime(new Date('2026-10-21T10:02:00.000Z'));
    otherPage.addMeasurement('weight', 81, '2024-02-01T00:00:00.000Z');
    await otherPage.flush();
    for (const k of Object.keys(OFF_FILE)) expect(localStorage.getItem(k), k).toBeNull();
    for (const [k, v] of Object.entries(KEEP)) expect(localStorage.getItem(k)).toBe(v);
  });
});

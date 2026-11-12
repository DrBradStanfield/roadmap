/** @vitest-environment jsdom */
// US-09 AC2c: every named file the on-device adapter writes takes the record's
// write rule. A page that may not write health values to this device stores no
// named file; a guest page that opened with no log-off on this device since it
// loaded always may. Each test runs in a fresh module graph, as a fresh page,
// because the write state lives for the page.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));

const ROOT = resolve(__dirname, '../../..');
const CHAT_KEY = 'health_roadmap_file_v2:chat-history.json';
const GUEST_TEXT = 'SYNTHETIC_GUEST_QUESTION';

/** Today's named files, each marked for whether it holds health data. A new
 *  named file fails the pin below until it is classified here. */
const NAMED_FILES: Record<string, { health: boolean }> = {
  'health-roadmap.json': { health: true },
  'chat-history.json': { health: true },
};

/** Every named file the sources declare: `fileName: '…json'` or `…_FILE_NAME = '…json'`. */
function declaredNamedFiles(): string[] {
  const found = new Set<string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) { if (name !== 'node_modules') walk(path); continue; }
      if (!/\.tsx?$/.test(name) || /\.test\.tsx?$/.test(name)) continue;
      for (const m of readFileSync(path, 'utf8').matchAll(/(?:fileName:|_FILE_NAME\s*=)\s*'([^']+\.json)'/g)) found.add(m[1]);
    }
  };
  for (const dir of ['packages/health-core/src', 'widget-src/src', 'widget-src/standalone']) walk(join(ROOT, dir));
  return [...found].sort();
}

async function page() {
  vi.resetModules();
  return {
    lib: await import('../lib/storage'),
    local: await import('./local-storage-adapter'),
    chat: await import('./chat-history-store'),
    errors: await import('../lib/error-diagnostics'),
    adapter: await import('@roadmap/health-core/adapter'),
  };
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('US-09 AC2c: the on-device adapter writes a named file only while the page may write health values here', () => {
  it('pins today\'s named files and whether each holds health data', () => {
    expect(declaredNamedFiles()).toEqual(Object.keys(NAMED_FILES).sort());
  });

  it('a stopped cloud page refuses a device write of every named file, a new one included', async () => {
    const { lib, local } = await page();
    lib.noteCloudPage('dropbox');
    local.stopRoadmapLocalWrites();
    const adapter = new local.LocalStorageAdapter();
    for (const name of [...Object.keys(NAMED_FILES), 'zz-new-file.json']) {
      expect(() => adapter.writeSync(name, { a: 1 }, null), name).toThrow('On-device roadmap persistence stopped for logout.');
    }
    // Only the content-free log-off id remains.
    expect(Object.keys(localStorage).filter((key) => key.startsWith('health_roadmap_file_v2'))).toEqual([]);
  });

  it('A15: the refusal is a WritesStoppedError, still a StorageError, from writeSync and writeDocument', async () => {
    const { lib, local, errors, adapter: core } = await page();
    lib.noteCloudPage('dropbox');
    local.stopRoadmapLocalWrites();
    const adapter = new local.LocalStorageAdapter();
    const refusals: unknown[] = [];
    try { adapter.writeSync('chat-history.json', { a: 1 }, null); } catch (error) { refusals.push(error); }
    await adapter.writeDocument('synthetic.pdf', new Blob(['synthetic'])).catch((error: unknown) => refusals.push(error));
    expect(refusals).toHaveLength(2);
    for (const error of refusals) {
      expect(error).toBeInstanceOf(errors.WritesStoppedError);
      expect(error).toBeInstanceOf(core.StorageError);
      expect((error as Error).name).toBe('WritesStoppedError');
      expect((error as Error).message).toBe('On-device roadmap persistence stopped for logout.');
    }
  });

  it("a guest's chat history still saves, after another tab's log-off too", async () => {
    const { lib, local, chat } = await page();
    const store = await chat.ChatHistoryStore.create(new local.LocalStorageAdapter());
    await store.recordExchange({ conversationId: 'c1', isNew: true, userText: GUEST_TEXT, assistantText: 'Synthetic answer' });
    expect(localStorage.getItem(CHAT_KEY)).toContain(GUEST_TEXT);
    lib.noteLogOffHeard();
    await store.recordExchange({ conversationId: 'c2', isNew: true, userText: `${GUEST_TEXT}_2`, assistantText: 'Synthetic answer' });
    expect(localStorage.getItem(CHAT_KEY)).toContain(`${GUEST_TEXT}_2`);
  });
});

/**
 * Lead TA-2: the edit_record CLI saves no last-write-wins stamp later than the
 * saved record's own `meta.updatedAt` (migrate.ts clamps one, and it can then
 * lose a tie, US-10 AC8). Each command runs for real over the record file
 * (FileAdapter, SyncManager), with the machine's clock an hour ahead of the
 * record and an hour behind it, and the file's RAW bytes are walked
 * (stamp-anchor.test-helpers.ts). Test-only, a synthetic record in a temp dir.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROADMAP_FILE_NAME } from '../packages/health-core/src/adapter';
import { stampCount, stampedRecord, stampsAheadOfMeta } from '../packages/health-core/src/stamp-anchor.test-helpers';
import { run } from './edit-record';

const T0 = '2026-09-01T09:00:00.000Z';
const CLOCKS = { ahead: '2026-09-01T10:00:00.000Z', behind: '2026-09-01T08:00:00.000Z' } as const;

const COMMANDS: Record<string, (path: string) => string[]> = {
  'add a vital': (path) => ['add', path, '--metric', 'weight', '--value', '80', '--date', '2026-08-25'],
  'add a lab test': (path) => ['add', path, '--test', 'Ferritin', '--value', '210', '--unit', 'µg/L', '--date', '2026-08-25'],
  correct: (path) => ['correct', path, '--id', 'l1', '--value', '2.1'],
};

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('TA-2: edit_record CLI writes stamp nothing past meta.updatedAt', () => {
  for (const [clock, now] of Object.entries(CLOCKS)) {
    it.each(Object.keys(COMMANDS))(`%s, machine clock ${clock} of the record`, async (name) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(now));
      const dir = mkdtempSync(join(tmpdir(), 'ta2-cli-'));
      dirs.push(dir);
      const path = join(dir, ROADMAP_FILE_NAME);
      const before = JSON.stringify(stampedRecord(T0));
      writeFileSync(path, before);
      vi.spyOn(process.stdout, 'write').mockReturnValue(true);
      vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      expect(await run(COMMANDS[name](path))).toBe(0);
      const written = readFileSync(path, 'utf8');
      expect(written).not.toBe(before); // it wrote
      expect(stampCount(JSON.parse(written))).toBeGreaterThan(0);
      expect(stampsAheadOfMeta(JSON.parse(written))).toEqual([]);
    });
  }
});

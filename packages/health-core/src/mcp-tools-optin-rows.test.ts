/**
 * US-32 AC67: the opt-in's nested `tokens` rows (US-17 AC19) never leave
 * through an agent tool. `redactRecord` strips `reminderOptIn` whole, so every
 * row inside it goes with it. Synthetic tokens and addresses.
 */
import { describe, expect, it } from 'vitest';
import { callTool, getPlan, readRecord, redactRecord } from './mcp-tools';
import { mergeFiles } from './merge';
import { createEmptyFile, type FileReminderOptIn, type RoadmapFile } from './roadmap-file';

const NOW = '2026-09-01T09:00:00Z';
const CTX = { deviceId: 'dev_optin_rows', now: NOW };

function withOptIn(optIn: FileReminderOptIn): RoadmapFile {
  const file = createEmptyFile(CTX);
  Object.assign(file.profile, { sex: 'female', birthYear: 1975, heightCm: 165, unitSystem: 'si' });
  file.reminderOptIn = optIn;
  return file;
}

describe('US-32 AC67: the opt-in rows never reach an agent', () => {
  // Two devices, two tokens: the merge writes the older token as a nested row.
  const merged = mergeFiles(
    withOptIn({ status: 'active', token: 'test-token-one', email: 'one@example.test', provider: 'dropbox', updatedAt: '2026-08-01T00:00:00Z', lamport: 1 }),
    withOptIn({ status: 'cancelled', token: 'test-token-two', email: 'two@example.test', provider: 'github', updatedAt: '2026-08-02T00:00:00Z', lamport: 1 }),
    CTX,
  );

  it('the record does hold both tokens, one nested', () => {
    expect(merged.reminderOptIn?.token).toBe('test-token-two');
    expect(merged.reminderOptIn?.tokens?.map((r) => r.token)).toEqual(['test-token-one']);
  });

  it('read_record, get_plan and the dispatcher show no token, address or row', () => {
    const outcomes = [
      readRecord(merged, {}),
      getPlan(merged, NOW),
      callTool('read_record', {}, { file: merged, now: NOW }),
      callTool('get_plan', {}, { file: merged, now: NOW }),
    ];
    const texts = [...outcomes.map((o) => { expect(o.status).toBe('ok'); return o.text; }), JSON.stringify(redactRecord(merged))];
    for (const text of texts) {
      for (const secret of ['test-token-one', 'test-token-two', 'one@example.test', 'two@example.test', '"tokens"', 'reminderOptIn']) {
        expect(text).not.toContain(secret);
      }
    }
    // The strip is a copy: the record keeps its rows.
    expect(merged.reminderOptIn?.tokens).toHaveLength(1);
  });
});

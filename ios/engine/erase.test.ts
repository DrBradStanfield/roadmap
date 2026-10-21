// US-25 AC13 (US-11 on the iPhone): "Delete all my data" while the record is
// the phone's own file. The erase is health-core's (erase.ts), the chat
// history's is ChatSession.eraseAll; this door only runs them in the web's
// order. The cloud erase is in cloud.test.ts.
import { describe, expect, it } from 'vitest';
import { eraseOnPhone } from './erase';
import { chatRecordExchangeJson, settledJson } from './app-doors';
import { applyEdit, newRecord } from './my-data';
import type { RoadmapFile } from '../../packages/health-core/src/roadmap-file';

const NOW = '2026-10-21T08:00:00.000Z';
const LATER = '2026-10-21T09:00:00.000Z';

function recordWithWeight(): RoadmapFile {
  const outcome = applyEdit(newRecord(NOW, 'ios-1', 'en-NZ', 'Pacific/Auckland'), { kind: 'add', metric: 'weight', value: 80, day: '2026-10-01' }, NOW);
  if (!outcome.ok) throw new Error(outcome.message);
  return outcome.file;
}

async function historyWithOneChat(): Promise<string> {
  chatRecordExchangeJson(null, JSON.stringify({ conversationId: 'c1', isNew: true, userText: 'Is my LDL high?', assistantText: 'It is in range.', isFallback: false }), NOW, 'ios-1');
  await new Promise((resolve) => setTimeout(resolve, 0));
  const settled = JSON.parse(settledJson()) as { ok: boolean; value: string };
  expect(settled.ok).toBe(true);
  return settled.value;
}

describe('eraseOnPhone (US-25 AC13, US-11)', () => {
  it('erases the record by the engine rule: epoch bumped, every row listed, no row left', async () => {
    const before = recordWithWeight();
    const result = await eraseOnPhone(JSON.stringify(before), null, LATER, 'ios-1');
    const erased = JSON.parse(result.record) as RoadmapFile;
    expect(erased.meta.eraseEpoch).toBe((before.meta.eraseEpoch ?? 0) + 1);
    expect(erased.measurements).toEqual([]);
    expect(erased.erasedRows?.ids).toEqual(before.measurements.map((m) => m.id).sort());
    expect(erased.profile.sex ?? null).toBeNull();
  });

  it('tombstones every conversation, titles and messages gone', async () => {
    const history = await historyWithOneChat();
    expect(history).toContain('Is my LDL high?');
    const result = await eraseOnPhone(JSON.stringify(recordWithWeight()), history, LATER, 'ios-1');
    expect(result.chatErased).toBe(true);
    expect(result.chatHistory).not.toBeNull();
    expect(result.chatHistory).not.toContain('Is my LDL high?');
    expect(result.chatHistory).not.toContain('It is in range.');
    const file = JSON.parse(result.chatHistory!) as { conversations: Array<{ deleted?: boolean }> };
    expect(file.conversations.every((c) => c.deleted === true)).toBe(true);
  });

  it('with no chat history there is nothing to write', async () => {
    const result = await eraseOnPhone(JSON.stringify(recordWithWeight()), null, LATER, 'ios-1');
    expect(result.chatErased).toBe(true);
    expect(result.chatHistory).toBeNull();
  });

  it('a chat file that cannot be read does not stop the erase, and says so', async () => {
    const result = await eraseOnPhone(JSON.stringify(recordWithWeight()), '{not json', LATER, 'ios-1');
    expect(result.chatErased).toBe(false);
    expect((JSON.parse(result.record) as RoadmapFile).measurements).toEqual([]);
  });

  it('refuses a record it cannot read: nothing is listed, so nothing is erased', async () => {
    await expect(eraseOnPhone('{not json', await historyWithOneChat(), LATER, 'ios-1')).rejects.toThrow();
    await expect(eraseOnPhone('[]', null, LATER, 'ios-1')).rejects.toThrow();
  });
});

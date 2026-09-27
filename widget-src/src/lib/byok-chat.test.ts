/**
 * BYOK chat context — the record file is an untrusted boundary.
 *
 * A hand-edited or corrupted health-roadmap.json used to null the ENTIRE chat
 * context ("none entered yet") on the first field the schema rejected. One bad
 * number must cost its own field and nothing else.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
  sent: null as { system: string } | null,
}));

vi.mock('./chat-history-access', () => ({ getChatHistory: () => Promise.resolve(null) }));
vi.mock('./byok-anthropic', () => ({
  ByokAnthropicError: class ByokAnthropicError extends Error {},
  callAnthropicDirectRaw: async (_key: string, body: { system: string }) => {
    state.sent = body;
    return { text: 'ok', blocks: [] };
  },
}));

import { buildChatContextJson } from '@roadmap/health-core';
import { sendMessage } from './byok-chat';

const SNAPSHOT = {
  sex: 'male',
  heightCm: 178,
  birthYear: 1971,
  hdlC: 1.2,
  weightKg: 92.4,
  systolicBp: 138,
  diastolicBp: 86,
  unitSystem: 'si',
  medications: [],
  screenings: [],
};

interface ChatContext {
  profile: Record<string, unknown>;
  latestValues: Record<string, string | undefined>;
  excludedFields?: string[];
}

/** The JSON the system prompt carries, or null when the chat sent none. */
async function contextSent(snapshot: Record<string, unknown> | null): Promise<ChatContext | null> {
  state.sent = null;
  await sendMessage('hi', null, snapshot);
  const system = state.sent!.system;
  const marker = 'User data:\n';
  return system.includes(marker) ? JSON.parse(system.slice(system.indexOf(marker) + marker.length)) : null;
}

describe('BYOK chat context — per-field sanitizing', () => {
  beforeEach(() => {
    const store = new Map([['hr_anthropic_key', 'sk-ant-test']]);
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
  });

  it('drops one out-of-range field and keeps the rest of the context', async () => {
    const context = await contextSent({ ...SNAPSHOT, ldlC: 9999 });
    expect(context).not.toBeNull();
    expect(context!.latestValues.ldlC).toBeUndefined();
    expect(context!.latestValues.hdlC).toBe('1.2');
    expect(context!.latestValues.systolicBp).toBe('138');
    expect(context!.profile).toMatchObject({ sex: 'male', heightCm: 178 });
  });

  it('sends the full context when every field is valid', async () => {
    const context = await contextSent({ ...SNAPSHOT, ldlC: 2.1 });
    expect(context!.latestValues.ldlC).toBe('2.1');
  });

  it('still sends no context when the required fields are unusable', async () => {
    expect(await contextSent({ ...SNAPSHOT, heightCm: 9999 })).toBeNull();
  });

  it('names the stripped field so the model knows a value exists but was unusable', async () => {
    const context = await contextSent({ ...SNAPSHOT, ldlC: 9999 });
    expect(context!.excludedFields).toEqual(['ldlC']);
  });

  it('adds no excludedFields entry when every field is valid', async () => {
    const context = await contextSent({ ...SNAPSHOT, ldlC: 2.1 });
    expect(context!.excludedFields).toBeUndefined();
  });

  it('never puts the invalid value anywhere in the request', async () => {
    await contextSent({ ...SNAPSHOT, ldlC: 9999 });
    expect(JSON.stringify(state.sent)).not.toContain('9999');
  });

  it('US-15 AC11: the Pages chat reads the context through the same builder as the website chat', async () => {
    const statin = { id: 'm1', medicationKey: 'statin', drugName: 'rosuvastatin', doseValue: 40, doseUnit: 'mg', updatedAt: '2026-09-01' };
    const snapshot = { ...SNAPSHOT, apoB: 1.0, medications: [statin] };
    await contextSent(snapshot);
    const system = state.sent!.system;
    expect(system.slice(system.indexOf('User data:\n') + 'User data:\n'.length)).toBe(buildChatContextJson(snapshot));
    expect(system).toContain('"drug": "rosuvastatin"');
  });

  it('US-15 AC10: plans from the context the widget supplies (unsaved typed values)', async () => {
    state.sent = null;
    const typed = { ...SNAPSHOT, ldlC: 3.4, weightKg: 88 };
    await sendMessage('hi', null, typed);
    const system = state.sent!.system;
    expect(system.slice(system.indexOf('User data:\n') + 'User data:\n'.length)).toBe(buildChatContextJson(typed));
    const context = JSON.parse(system.slice(system.indexOf('User data:\n') + 'User data:\n'.length));
    expect(context.latestValues.ldlC).toBe('3.4');
    expect(context.latestValues.weightKg).toBe('88');
  });
});

/**
 * BYOK chat context — the record file is an untrusted boundary.
 *
 * A hand-edited or corrupted health-roadmap.json used to null the ENTIRE chat
 * context ("none entered yet") on the first field the schema rejected. One bad
 * number must cost its own field and nothing else.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
  snapshot: null as Record<string, unknown> | null,
  sent: null as { system: string } | null,
}));

vi.mock('./roadmap-data', () => ({ getByokChatInputs: () => state.snapshot }));
vi.mock('./chat-history-access', () => ({ getChatHistory: () => Promise.resolve(null) }));
vi.mock('./byok-anthropic', () => ({
  ByokAnthropicError: class ByokAnthropicError extends Error {},
  callAnthropicDirectRaw: async (_key: string, body: { system: string }) => {
    state.sent = body;
    return { text: 'ok', blocks: [] };
  },
}));

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
  inputs: Record<string, number | string | undefined>;
}

/** The JSON the system prompt carries, or null when the chat sent none. */
async function contextSent(snapshot: Record<string, unknown> | null): Promise<ChatContext | null> {
  state.snapshot = snapshot;
  state.sent = null;
  await sendMessage('hi');
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
    expect(context!.inputs.ldlC).toBeUndefined();
    expect(context!.inputs.hdlC).toBe(1.2);
    expect(context!.inputs.systolicBp).toBe(138);
    expect(context!.profile).toMatchObject({ sex: 'male', heightCm: 178 });
  });

  it('sends the full context when every field is valid', async () => {
    const context = await contextSent({ ...SNAPSHOT, ldlC: 2.1 });
    expect(context!.inputs.ldlC).toBe(2.1);
  });

  it('still sends no context when the required fields are unusable', async () => {
    expect(await contextSent({ ...SNAPSHOT, heightCm: 9999 })).toBeNull();
  });
});

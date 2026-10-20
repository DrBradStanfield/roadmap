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
  /** Every request body, and replies to hand back in order (then the default). */
  bodies: [] as Array<Record<string, any>>,
  replies: [] as Array<{ text: string; blocks: unknown[] } | Error>,
}));

vi.mock('./chat-history-access', () => ({ getChatHistory: () => Promise.resolve(null) }));
vi.mock('./byok-anthropic', () => ({
  ByokAnthropicError: class ByokAnthropicError extends Error {},
  callAnthropicDirectRaw: async (_key: string, body: { system: string }) => {
    state.sent = body;
    state.bodies.push(body);
    const reply = state.replies.shift() ?? { text: 'ok', blocks: [] };
    if (reply instanceof Error) throw reply;
    return reply;
  },
}));

import { buildChatContextJson, MINOR_CHAT_RULE } from '@roadmap/health-core';
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

  // US-15 AC36 (2026-10-18): an unusable height used to drop the whole context ("none entered yet").
  it('US-15 AC36: an unusable height sends the saved values with no plan, and the prompt says to ask for it and why', async () => {
    const context = await contextSent({ ...SNAPSHOT, heightCm: 9999 }) as ChatContext & Record<string, unknown>;
    expect(context).not.toBeNull();
    expect(context.latestValues.systolicBp).toBe('138');
    expect(context.excludedFields).toEqual(['heightCm']);
    expect(context.missingInputs).toContain('heightCm');
    expect(context).not.toHaveProperty('currentSuggestions');
    expect(state.sent!.system).toMatch(/no `currentSuggestions`.*ask them for the missing sex or height/i);
    // US-16 AC2: once stated, the chat proposes saving them; the tool stays an option.
    expect(state.sent!.system).toMatch(/propose saving them with `propose_profile_edit`.*enter them in the roadmap tool/);
    expect(state.sent!.system).toMatch(/needs height and sex to work out the plan/);
  });

  it('US-15 AC36: an empty form still sends no context', async () => {
    expect(await contextSent({ unitSystem: 'si', medications: [], screenings: [] })).toBeNull();
    expect(state.sent!.system).toContain('User data: none entered yet');
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

// US-07 AC6 (Codex R2, 2026-10-14): the Pages chat sends its own prompt, never
// the website chat's, so it carries the minor rule itself, from the one text.
describe('US-07 AC6: the Pages chat and a known minor', () => {
  beforeEach(() => {
    const store = new Map([['hr_anthropic_key', 'sk-ant-test']]);
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
  });
  const MINOR = { ...SNAPSHOT, birthYear: new Date().getFullYear() - 15, ldlC: 4.2 };

  it('US-07 AC6: the outgoing request carries the minor rule and the knownMinor profile', async () => {
    const context = await contextSent(MINOR);
    expect(state.sent!.system).toContain(MINOR_CHAT_RULE);
    expect(context!.profile).toMatchObject({ knownMinor: true });
  });

  it('US-07 AC6: a known minor with no height still sends a context marked knownMinor (Codex R1)', async () => {
    const { heightCm: _, ...noHeight } = MINOR;
    const context = await contextSent(noHeight);
    expect(context!.profile).toMatchObject({ knownMinor: true });
    expect(context!.latestValues.ldlC).toBe('4.2');
    expect(state.sent!.system).toContain(MINOR_CHAT_RULE);
  });
});

// US-15 AC33: the Pages chat runs the same one-round run_roadmap loop as the
// website chat, with the plan computed here in the browser.
describe('US-15 AC33: run_roadmap in the Pages chat', () => {
  const RUN = { type: 'tool_use', id: 'toolu_run', name: 'run_roadmap', input: { values: [{ field: 'ldlC', value: 4.1, unit: 'mmol/L' }] } };
  const FIELD = { type: 'tool_use', id: 'toolu_field', name: 'propose_field_edit', input: { field: 'ldlC', value: 4.1, unit: 'mmol/L' } };

  beforeEach(() => {
    state.bodies = [];
    state.replies = [];
    const store = new Map([['hr_anthropic_key', 'sk-ant-test']]);
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
  });

  it('offers run_roadmap with the form tools only when the message has a digit; its guidance is in the tool, not the prompt', async () => {
    await sendMessage('hi', null, SNAPSHOT);
    await sendMessage('my LDL is 4.1 mmol/L', null, SNAPSHOT);
    expect(state.bodies[0].tools.map((t: { name: string }) => t.name)).toEqual(['propose_field_edit', 'propose_medication_edit', 'propose_profile_edit']);
    expect(state.bodies[1].tools.map((t: { name: string }) => t.name)).toEqual(['propose_field_edit', 'propose_medication_edit', 'propose_profile_edit', 'run_roadmap']);
    expect(state.bodies[1].tools[3].description).toContain('Answer only from the result');
    expect(state.bodies[1].system).not.toContain('run_roadmap');
    // C10: the form-tools rule names the form tools, so it does not forbid run_roadmap.
    expect(state.bodies[1].system).not.toMatch(/Use tools only|without any tool/);
    expect(state.bodies[1].system).toContain('without these tools when no edit is requested. Use them only when');
  });

  it('computes the plan in the browser on the stated values, then answers from a second call with no tools', async () => {
    state.replies = [{ text: '', blocks: [RUN, FIELD] }, { text: 'From your roadmap.', blocks: [{ type: 'text', text: 'From your roadmap.' }] }];
    const { result, error } = await sendMessage('analyse: LDL 4.1 mmol/L', null, SNAPSHOT);
    expect(error).toBeNull();
    expect(result!.content).toBe('From your roadmap.');
    expect(result!.proposedEdits).toEqual([{ kind: 'field', field: 'ldlC', displayValue: 4.1, unitSystem: 'si', date: null }]);
    expect(state.bodies).toHaveLength(2);
    const second = state.bodies[1];
    expect(second.tool_choice).toEqual({ type: 'none' });
    expect(second.messages.at(-2)).toEqual({ role: 'assistant', content: [RUN, FIELD] });
    const [runResult, fieldResult] = second.messages.at(-1).content;
    const roadmap = JSON.parse(runResult.content).roadmap;
    expect(roadmap).toEqual(JSON.parse(buildChatContextJson({ ...SNAPSHOT, ldlC: 4.1 })!));
    expect(fieldResult.tool_use_id).toBe('toolu_field');
  });

  it('adversary R3: the tool takes a stated age, and the plan computed in the browser applies the minor gate to it', async () => {
    const run = { ...RUN, input: { values: [], sex: 'male', height: { value: 170, unit: 'cm' }, age: 17 } };
    state.replies = [{ text: '', blocks: [run] }, { text: 'Under 18.', blocks: [{ type: 'text', text: 'Under 18.' }] }];
    await sendMessage('I am 17, LDL 4.1 mmol/L', null, null);
    const tool = state.bodies[0].tools.find((t: { name: string }) => t.name === 'run_roadmap');
    expect(tool.input_schema.properties.age.type).toBe('integer');
    expect(tool.input_schema.properties.birthYear.description).toMatch(/do not compute/i);
    const result = JSON.parse(state.bodies[1].messages.at(-1).content[0].content);
    expect(result.applied).toEqual(['sex', 'heightCm', 'age']);
    expect(result.roadmap.profile.knownMinor).toBe(true);
  });

  it('a failed second call is the chat\'s error, not a partial answer', async () => {
    state.replies = [{ text: '', blocks: [RUN] }, new TypeError('network down')];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { result, error } = await sendMessage('analyse: LDL 4.1 mmol/L', null, SNAPSHOT);
    expect(result).toBeNull();
    expect(error).toEqual({ error: 'Network error reaching Anthropic. Check your connection.' });
    warn.mockRestore();
  });
});

// US-15 AC34: the Pages chat runs on Haiku 5.5, which 400s on sampling params
// and on an assistant prefill, and thinks unless told not to.
describe('US-15 AC34: the Pages chat request on Haiku 5.5', () => {
  beforeEach(() => {
    const store = new Map([['hr_anthropic_key', 'sk-ant-test']]);
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
  });

  it('sends Haiku 5.5 with thinking disabled, no temperature, ending on the user turn', async () => {
    await sendMessage('hi', null, SNAPSHOT);
    const body = state.sent as unknown as Record<string, any>;
    expect(body.model).toBe('claude-haiku-5-5');
    expect(body.max_tokens).toBe(2048);
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body).not.toHaveProperty('temperature');
    expect(body.messages.at(-1)).toEqual({ role: 'user', content: 'hi' });
  });
});

describe('US-15 AC34: a Pages chat reply cut off before any text is an error, not a blank answer', () => {
  beforeEach(() => {
    const store = new Map([['hr_anthropic_key', 'sk-ant-test']]);
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
    state.replies = [];
  });

  it('returns the empty-response error and no result', async () => {
    state.replies = [{ text: '', blocks: [] }];
    const out = await sendMessage('hi', null, SNAPSHOT);
    expect(out.result).toBeNull();
    expect(out.error).toEqual({ error: 'Empty response from Anthropic. Try again.' });
  });
});

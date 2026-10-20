/**
 * US-15 AC33: run_roadmap runs the plan code on the saved data plus values
 * stated in the chat, and returns exactly buildChatContextJson's output. The
 * one-round loop is shared by every chat transport.
 */
import { describe, it, expect, vi } from 'vitest';
import { buildChatContextJson } from './chat-context';
import { reportedToCanonical } from './units';
import { EDITABLE_FIELDS, PROPOSE_FIELD_EDIT_TOOL } from './chat-edits';
import {
  runRoadmap, roadmapResultText, roadmapToolResults, withRoadmapRound,
  RUN_ROADMAP_MAX_VALUES, RUN_ROADMAP_TOOL, CHAT_TOOLS, chatToolsFor,
} from './run-roadmap';

const PROFILE = {
  unitSystem: 'si', medications: [], screenings: [],
  sex: 'male', heightCm: 178, weightKg: 80, waistCm: 90, birthYear: 1972, birthMonth: 5,
  ldlC: 2.4, hba1c: 34, systolicBp: 118, diastolicBp: 76,
};
const val = (field: string, value: number, unit: string, date?: string) => ({ field, value, unit, ...(date ? { date } : {}) });
const ctx = (json: string | null) => JSON.parse(json!);

describe('US-15 AC33: runRoadmap overlays stated values and returns the plan code\'s own output', () => {
  it('a stated value overrides the saved one: the output is exactly buildChatContextJson on the overlaid payload', () => {
    const run = runRoadmap(PROFILE, { values: [val('ldlC', 4.1, 'mmol/L'), val('systolicBp', 132, 'mmHg'), val('diastolicBp', 84, 'mmHg')] });
    expect(run.applied).toEqual(['ldlC', 'systolicBp', 'diastolicBp']);
    expect(run.rejected).toEqual([]);
    expect(run.contextJson).toBe(buildChatContextJson({ ...PROFILE, ldlC: 4.1, systolicBp: 132, diastolicBp: 84 }));
    expect(ctx(run.contextJson).latestValues).toMatchObject({ ldlC: '4.1', systolicBp: '132', diastolicBp: '84' });
    // The plan changed with the stated values: the saved data gives no BP card at 118/76.
    const saved = ctx(buildChatContextJson(PROFILE)).currentSuggestions.map((s: { id: string }) => s.id);
    const stated = ctx(run.contextJson).currentSuggestions.map((s: { id: string }) => s.id);
    expect(stated).not.toEqual(saved);
  });

  it('never changes the caller\'s payload', () => {
    const payload = structuredClone(PROFILE);
    runRoadmap(payload, { values: [val('ldlC', 4.1, 'mmol/L')], age: 46 });
    expect(payload).toEqual(PROFILE);
  });

  it('converts a stated unit with the unit table: mg/dL LDL, % HbA1c, mg/L Lp(a)', () => {
    const run = runRoadmap(PROFILE, { values: [val('ldlC', 158, 'mg/dL'), val('hba1c', 6.2, '%'), val('lpa', 300, 'mg/L')] });
    expect(run.applied).toEqual(['ldlC', 'hba1c', 'lpa']);
    expect(run.contextJson).toBe(buildChatContextJson({
      ...PROFILE,
      ldlC: reportedToCanonical('ldl', 158, 'mg/dL')!.valueSI,
      hba1c: reportedToCanonical('hba1c', 6.2, '%')!.valueSI,
      lpa: reportedToCanonical('lpa', 300, 'mg/L')!.valueSI,
    }));
    expect(Number(ctx(run.contextJson).latestValues.ldlC)).toBeCloseTo(4.09, 2);
  });

  it('rejects an unknown unit and a missing unit (ASK, never guess); the saved value does not answer for them (adversary R2)', () => {
    const run = runRoadmap(PROFILE, { values: [val('ldlC', 4.1, 'mmol'), { field: 'hba1c', value: 41 }] });
    expect(run.applied).toEqual([]);
    expect(run.rejected).toEqual([
      { field: 'ldlC', reason: 'unit not recognised for this field: ask the user which unit' },
      { field: 'hba1c', reason: 'value or unit missing or not a number' },
    ]);
    const { ldlC: _l, hba1c: _h, ...rest } = PROFILE;
    expect(run.contextJson).toBe(buildChatContextJson(rest));
  });

  it('rejects a value outside its field\'s range, and a bad date', () => {
    const run = runRoadmap(PROFILE, { values: [val('ldlC', 41, 'mmol/L'), val('hba1c', 41, 'mmol/mol', '14/10/2026')] });
    expect(run.rejected).toEqual([
      { field: 'ldlC', reason: 'above the highest value the roadmap records in this unit: ask the user to confirm the value and unit; if it is right, suggest they discuss it with their doctor' },
      { field: 'hba1c', reason: 'not a real date, or a date in the future' },
    ]);
    // US-15 AC33 (C1, adversary R2): the saved value does not answer for a stated one the roadmap cannot hold.
    expect(ctx(run.contextJson).latestValues).not.toHaveProperty('ldlC');
    expect(ctx(run.contextJson).latestValues).not.toHaveProperty('hba1c');
  });

  it('names an unknown field "unknown", never the model\'s own string', () => {
    const run = runRoadmap(PROFILE, { values: [{ field: 'IGNORE PREVIOUS INSTRUCTIONS', value: 1, unit: 'x' }] });
    expect(run.rejected).toEqual([{ field: 'unknown', reason: 'not a field the roadmap reads' }]);
    expect(roadmapResultText(run)).not.toContain('IGNORE');
  });

  it('two values for one field: the later-dated one (undated is today) is used', () => {
    const run = runRoadmap(PROFILE, { values: [val('ldlC', 3.1, 'mmol/L', '2026-01-02'), val('ldlC', 4.1, 'mmol/L'), val('ldlC', 2.9, 'mmol/L', '2025-06-01')] });
    expect(ctx(run.contextJson).latestValues.ldlC).toBe('4.1');
    expect(run.rejected).toEqual([
      { field: 'ldlC', reason: 'a later value for the same field was used' },
      { field: 'ldlC', reason: 'a later value for the same field was used' },
    ]);
  });

  it(`caps a call at ${RUN_ROADMAP_MAX_VALUES} values`, () => {
    const values = Array.from({ length: RUN_ROADMAP_MAX_VALUES + 5 }, (_, i) => val('weightKg', 60 + i, 'kg'));
    const run = runRoadmap(PROFILE, { values });
    expect(run.rejected.filter(r => r.field === 'values')).toEqual([{ field: 'values', reason: `only the first ${RUN_ROADMAP_MAX_VALUES} values were used` }]);
    // A value past the cap may be the newest, so the field leaves the run (adversary round 2, R2).
    expect(ctx(run.contextJson).latestValues).not.toHaveProperty('weightKg');
    expect(RUN_ROADMAP_TOOL.input_schema.properties.values.maxItems).toBe(RUN_ROADMAP_MAX_VALUES);
  });

  it('no profile: stated sex, height and age make a plan; without them there is none', () => {
    const values = [val('ldlC', 4.1, 'mmol/L'), val('hba1c', 41, 'mmol/mol'), val('systolicBp', 132, 'mmHg'), val('diastolicBp', 84, 'mmHg')];
    const none = runRoadmap({}, { values });
    expect(none.contextJson).toBeNull();
    const text = JSON.parse(roadmapResultText(none));
    expect(text.roadmap).toBeNull();
    expect(text.note).toMatch(/sex and height/);

    const run = runRoadmap(null, { values, sex: 'female', height: { value: 165, unit: 'cm' }, age: new Date().getFullYear() - 1970 });
    expect(run.applied).toEqual(['ldlC', 'hba1c', 'systolicBp', 'diastolicBp', 'sex', 'heightCm', 'age']);
    expect(run.contextJson).toBe(buildChatContextJson({ ldlC: 4.1, hba1c: 41, systolicBp: 132, diastolicBp: 84, sex: 'female', heightCm: 165, birthYear: 1970, birthMonth: 1, unitSystem: 'si' }));
    expect(ctx(run.contextJson).profile).toMatchObject({ sex: 'female', heightCm: 165, unitSystem: 'si' });
    expect(ctx(run.contextJson).profile.age).toBeGreaterThan(50);
    expect(ctx(run.contextJson).currentSuggestions.length).toBeGreaterThan(0);
  });

  it('with no saved unit preference the plan prints in the system the user wrote in', () => {
    const run = runRoadmap({}, { values: [val('ldlC', 158, 'mg/dL')], sex: 'male', height: { value: 180, unit: 'cm' } });
    expect(ctx(run.contextJson).profile.unitSystem).toBe('conventional');
    expect(ctx(runRoadmap(PROFILE, { values: [val('ldlC', 158, 'mg/dL')] }).contextJson).profile.unitSystem).toBe('si');
  });

  it('rejects an out-of-range profile value', () => {
    const run = runRoadmap(PROFILE, { values: [], sex: 'other', height: { value: 900, unit: 'cm' }, age: -3 });
    expect(run.rejected.map(r => r.field)).toEqual(['sex', 'heightCm', 'age']);
  });

  it('a known minor gets the minor context and no plan, as the prompt\'s user data block does (US-07 AC6)', () => {
    const run = runRoadmap({}, { values: [val('ldlC', 4.1, 'mmol/L')], sex: 'male', height: { value: 170, unit: 'cm' }, age: 15 });
    expect(ctx(run.contextJson).profile.knownMinor).toBe(true);
  });

  it('the result text carries buildChatContextJson\'s output verbatim', () => {
    const run = runRoadmap(PROFILE, { values: [val('ldlC', 4.1, 'mmol/L')] });
    const text = roadmapResultText(run);
    expect(text).toContain(run.contextJson!);
    expect(JSON.parse(text)).toMatchObject({ applied: ['ldlC'], rejected: [], roadmap: ctx(run.contextJson) });
  });

  it('CHAT_TOOLS is the three form tools plus run_roadmap, which reuses the form tool\'s field enum', () => {
    expect(CHAT_TOOLS.map(t => t.name)).toEqual(['propose_field_edit', 'propose_medication_edit', 'propose_profile_edit', 'run_roadmap']);
    expect(RUN_ROADMAP_TOOL.input_schema.properties.values.items.properties.field.enum)
      .toEqual(PROPOSE_FIELD_EDIT_TOOL.input_schema.properties.field.enum);
  });

  it('chatToolsFor offers run_roadmap only when the latest or the previous user message has a digit (C2)', () => {
    const names = (content: string, earlier: string[] = []) => chatToolsFor([
      ...earlier.flatMap(c => [{ role: 'user' as const, content: c }, { role: 'assistant' as const, content: 'ok' }]),
      { role: 'user', content },
    ]).map(t => t.name);
    expect(names('analyse my data: LDL 4.1 mmol/L')).toEqual(['propose_field_edit', 'propose_medication_edit', 'propose_profile_edit', 'run_roadmap']);
    expect(names('My Lp(a) came back at 75')).toContain('run_roadmap');
    expect(names('I have chest pain and I took Viagra yesterday. Can I use my GTN spray?')).toEqual(['propose_field_edit', 'propose_medication_edit', 'propose_profile_edit']);
    // The previous user message counts too: "Lp(a) 75", the unit asked, then "nmol/L".
    expect(names('nmol/L', ['My Lp(a) came back at 75'])).toContain('run_roadmap');
    expect(names('female, five foot five', ['analyse: LDL 4.1 mmol/L'])).toContain('run_roadmap');
    // Two user messages back does not.
    expect(names('can you analyse that?', ['LDL 4.1 mmol/L', 'thanks'])).not.toContain('run_roadmap');
    expect(chatToolsFor([]).map(t => t.name)).not.toContain('run_roadmap');
  });

  // US-16 AC2 (adversary R1): a widget built before the profile tool gets the old set.
  it('chatToolsFor without profile edits leaves out propose_profile_edit, and only it', () => {
    const said = (content: string) => [{ role: 'user' as const, content }];
    expect(chatToolsFor(said('LDL 4.1 mmol/L'), false).map(t => t.name)).toEqual(['propose_field_edit', 'propose_medication_edit', 'run_roadmap']);
    expect(chatToolsFor(said('hello'), false).map(t => t.name)).toEqual(['propose_field_edit', 'propose_medication_edit']);
  });

  it('the usage guidance lives in the tool description, not the system prompt', () => {
    const d = RUN_ROADMAP_TOOL.description;
    for (const rule of ['not in their saved data', 'do NOT convert', 'stated them in this conversation', 'ASK which unit',
      'do not grade the value in any unit', 'Answer only from the result', 'not saved', 'pre-fill',
      "the user's own values", "not a family member's"]) expect(d).toContain(rule);
  });

  // US-16 AC2 (2026-10-20, Brad): a stated sex or height can now be saved from the chat, with the
  // user's confirmation, through propose_profile_edit; the measurements' field enum still holds neither.
  it('US-16 AC2: offers to save a stated sex or height with propose_profile_edit, or in the roadmap tool', () => {
    expect(RUN_ROADMAP_TOOL.description).toContain('save a stated sex or height with propose_profile_edit (or they can enter them in the roadmap tool)');
    expect(RUN_ROADMAP_TOOL.description).not.toContain('never offer that for sex or height');
    expect(EDITABLE_FIELDS).not.toContain('sex');
    expect(EDITABLE_FIELDS).not.toContain('heightCm');
  });
});

describe('US-15 AC33: the one-round loop every chat shares', () => {
  const thinking = { type: 'thinking', thinking: 'Run it.', signature: 'sig-abc' };
  const runUse = { type: 'tool_use', id: 'toolu_1', name: 'run_roadmap', input: { values: [val('ldlC', 4.1, 'mmol/L')] } };
  const fieldUse = { type: 'tool_use', id: 'toolu_2', name: 'propose_field_edit', input: val('ldlC', 4.1, 'mmol/L') };
  const medUse = { type: 'tool_use', id: 'toolu_3', name: 'propose_medication_edit', input: { medicationKey: 'statin', drugName: 'atorvastatin', doseValue: 20, doseUnit: 'mg' } };
  const reply = (...contentBlocks: object[]) => ({ contentBlocks });
  const messages = [{ role: 'user' as const, content: 'analyse: LDL 4.1 mmol/L' }];

  it('no run_roadmap: one call, its edits, no round', async () => {
    const send = vi.fn().mockResolvedValueOnce(reply({ type: 'text', text: 'Answer' }, fieldUse));
    const turn = await withRoadmapRound(messages, send, PROFILE);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toEqual({ messages });
    expect(turn.counts).toBeNull();
    expect(turn.final).toBe(turn.first);
    expect(turn.proposedEdits).toHaveLength(1);
  });

  it('run_roadmap: a second call replays the reply unmodified, answers every tool_use, and offers no tools', async () => {
    const first = reply(thinking, { type: 'text', text: 'Let me run that.' }, runUse, fieldUse, medUse);
    const send = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(reply({ type: 'text', text: 'From the roadmap.' }));
    const onRound = vi.fn();
    const turn = await withRoadmapRound(messages, send, PROFILE, onRound);
    expect(send).toHaveBeenCalledTimes(2);
    expect(onRound).toHaveBeenCalledTimes(1);
    expect(onRound).toHaveBeenCalledWith({ applied: 1, rejected: 0 });
    const second = send.mock.calls[1][0];
    expect(second.tool_choice).toEqual({ type: 'none' });
    expect(second.messages[0]).toEqual(messages[0]);
    expect(second.messages[1]).toEqual({ role: 'assistant', content: first.contentBlocks });
    expect(second.messages[1].content[0]).toBe(thinking); // the signed thinking block, untouched
    const results = second.messages[2].content;
    expect(second.messages[2].role).toBe('user');
    expect(results.map((r: { tool_use_id: string }) => r.tool_use_id)).toEqual(['toolu_1', 'toolu_2', 'toolu_3']);
    expect(JSON.parse(results[0].content).roadmap).toEqual(ctx(runRoadmap(PROFILE, runUse.input).contextJson));
    expect(results[1].content).toBe('Pre-filled for the user to review and Save.');
    expect(results[2].content).toMatch(/save at once/);
    expect(turn.counts).toEqual({ applied: 1, rejected: 0 });
    expect(turn.proposedEdits.map(e => e.kind)).toEqual(['field', 'medication']);
    expect(roadmapToolResults([fieldUse], PROFILE)).toBeNull();
  });

  it('a failed second call rejects, so the caller takes its failure path', async () => {
    const send = vi.fn().mockResolvedValueOnce(reply(runUse)).mockRejectedValueOnce(new Error('Anthropic API error (status 500)'));
    await expect(withRoadmapRound(messages, send, PROFILE)).rejects.toThrow('status 500');
  });
});

// US-15 AC33, second adversarial review (2026-10-15). Seeds: the reviewers' probes.
describe('US-15 AC33: a stated value the roadmap cannot hold never lets a saved one answer (C1)', () => {
  const ABOVE = 'above the highest blood pressure the roadmap records: treat it as a possible emergency and advise urgent medical care';
  const LAB_ABOVE = 'above the highest value the roadmap records in this unit: ask the user to confirm the value and unit; if it is right, suggest they discuss it with their doctor';
  const BODY = 'outside what the roadmap records: ask the user to check the value and unit';
  const PAIR = 'blood pressure is read as a pair: both numbers are needed, each one usable, so neither was used';
  const latest = (run: ReturnType<typeof runRoadmap>) => ctx(run.contextJson).latestValues;
  const cards = (run: ReturnType<typeof runRoadmap>) => ctx(run.contextJson).currentSuggestions.map((s: { id: string }) => s.id);
  const SAVED_BP = { ...PROFILE, measurementHistory: { systolic_bp: [{ date: '2026-09-01', value: 118 }], diastolic_bp: [{ date: '2026-09-01', value: 76 }] } };

  it('BP 260/155 over a saved 118/76: both rejected as above the range, and the saved reading is gone from latest and history', () => {
    const run = runRoadmap(SAVED_BP, { values: [val('systolicBp', 260, 'mmHg'), val('diastolicBp', 155, 'mmHg')] });
    expect(run.applied).toEqual([]);
    expect(run.rejected).toEqual([{ field: 'systolicBp', reason: ABOVE }, { field: 'diastolicBp', reason: ABOVE }]);
    expect(latest(run)).not.toHaveProperty('systolicBp');
    expect(latest(run)).not.toHaveProperty('diastolicBp');
    expect(run.contextJson).not.toContain('118');
    expect(ctx(run.contextJson).measurementHistory ?? {}).not.toHaveProperty('systolic_bp');
  });

  it('BP 230/155: the in-range systolic is not used alone; both rejected, saved pair removed', () => {
    const run = runRoadmap(PROFILE, { values: [val('systolicBp', 230, 'mmHg'), val('diastolicBp', 155, 'mmHg')] });
    expect(run.applied).toEqual([]);
    expect(run.rejected).toEqual([{ field: 'diastolicBp', reason: ABOVE }, { field: 'systolicBp', reason: PAIR }]);
    expect(latest(run)).not.toHaveProperty('systolicBp');
    expect(latest(run)).not.toHaveProperty('diastolicBp');
  });

  it('one BP number stated: neither is used, and the saved pair is removed', () => {
    const run = runRoadmap(PROFILE, { values: [val('systolicBp', 150, 'mmHg')] });
    expect(run.applied).toEqual([]);
    expect(run.rejected).toEqual([{ field: 'systolicBp', reason: PAIR }, { field: 'diastolicBp', reason: PAIR }]);
    expect(latest(run)).not.toHaveProperty('systolicBp');
    expect(latest(run)).not.toHaveProperty('diastolicBp');
  });

  it('a BP pair in range is used as before', () => {
    const run = runRoadmap(PROFILE, { values: [val('systolicBp', 142, 'mmHg'), val('diastolicBp', 92, 'mmHg')] });
    expect(run.applied).toEqual(['systolicBp', 'diastolicBp']);
    expect(latest(run)).toMatchObject({ systolicBp: '142', diastolicBp: '92' });
  });

  it('TG 25 mmol/L and Lp(a) 320 mg/dL: rejected as above, the saved value removed', () => {
    const saved = { ...PROFILE, triglycerides: 1.2, lpa: 40 };
    const run = runRoadmap(saved, { values: [val('triglycerides', 25, 'mmol/L'), val('lpa', 320, 'mg/dL')] });
    expect(run.rejected).toEqual([{ field: 'triglycerides', reason: LAB_ABOVE }, { field: 'lpa', reason: LAB_ABOVE }]);
    expect(latest(run)).not.toHaveProperty('triglycerides');
    expect(latest(run)).not.toHaveProperty('lpa');
    expect(latest(run).ldlC).toBe('2.4'); // the other saved values stay
  });

  it('a body measure out of range asks for a check: weight 10 kg', () => {
    const run = runRoadmap(PROFILE, { values: [val('weightKg', 10, 'kg')] });
    expect(run.rejected).toEqual([{ field: 'weightKg', reason: BODY }]);
    expect(latest(run)).not.toHaveProperty('weightKg');
    expect(cards(run)).toBeInstanceOf(Array);
  });
});

describe('US-15 AC33: a unit swap is asked, never read (C3, US-36 AC4 floors)', () => {
  const UNIT = 'unit not recognised for this field: ask the user which unit';
  it.each([
    ['ldlC', 3.4, 'mg/dL'], ['triglycerides', 1.5, 'mg/dL'], ['apoB', 0.9, 'mg/dL'],
  ])('%s %s %s is below the unit-swap floor: rejected with the unit reason; the saved value does not answer (adversary R2)', (field, value, unit) => {
    const run = runRoadmap({ ...PROFILE, triglycerides: 1.2, apoB: 0.9 }, { values: [val(field, value, unit)] });
    expect(run.applied).toEqual([]);
    expect(run.rejected).toEqual([{ field, reason: UNIT }]);
    expect(ctx(run.contextJson).latestValues).not.toHaveProperty(field);
  });
  it('a real value above the floor is used', () => {
    expect(runRoadmap(PROFILE, { values: [val('ldlC', 134, 'mg/dL')] }).applied).toEqual(['ldlC']);
  });
});

describe('US-15 AC33: dates (C4)', () => {
  const DATE = 'not a real date, or a date in the future';
  const OLDER = 'older than the saved value';
  const SAVED_LDL = { ...PROFILE, measurementHistory: { ldl: [{ date: '2025-01-10', value: 3.0 }, { date: '2026-09-01', value: 2.4 }] } };

  it('rejects an impossible date and a future one', () => {
    const run = runRoadmap(PROFILE, { values: [val('ldlC', 4.6, 'mmol/L', '2026-13-45'), val('hba1c', 41, 'mmol/mol', '2099-01-01'), val('weightKg', 81, 'kg', '2026-02-30')] });
    expect(run.applied).toEqual([]);
    expect(run.rejected).toEqual([{ field: 'ldlC', reason: DATE }, { field: 'hba1c', reason: DATE }, { field: 'weightKg', reason: DATE }]);
    // Adversary R2: the saved values do not answer for them.
    for (const f of ['ldlC', 'hba1c', 'weightKg']) expect(ctx(run.contextJson).latestValues).not.toHaveProperty(f);
  });

  it('a value dated before the latest saved point does not override it', () => {
    const run = runRoadmap(SAVED_LDL, { values: [val('ldlC', 5.2, 'mmol/L', '2015-03-01')] });
    expect(run.applied).toEqual([]);
    expect(run.rejected).toEqual([{ field: 'ldlC', reason: OLDER }]);
    expect(ctx(run.contextJson).latestValues.ldlC).toBe('2.4');
  });

  it('a value dated on or after the latest saved point, or undated (today), overrides it', () => {
    expect(runRoadmap(SAVED_LDL, { values: [val('ldlC', 4.6, 'mmol/L', '2026-09-01')] }).applied).toEqual(['ldlC']);
    expect(runRoadmap(SAVED_LDL, { values: [val('ldlC', 4.6, 'mmol/L', '2026-10-01')] }).applied).toEqual(['ldlC']);
    const undated = runRoadmap(SAVED_LDL, { values: [val('ldlC', 4.6, 'mmol/L')] });
    expect(ctx(undated.contextJson).latestValues.ldlC).toBe('4.6');
  });

  it('today in the earliest time zone is not the future', () => {
    const tomorrowUtc = new Date(Date.now() + 13 * 3600_000).toISOString().slice(0, 10);
    expect(runRoadmap(PROFILE, { values: [val('ldlC', 4.6, 'mmol/L', tomorrowUtc)] }).applied).toEqual(['ldlC']);
  });
});

describe('US-15 AC33: height goes through the unit table (C5)', () => {
  it('70 in is 177.8 cm, not 70 cm', () => {
    const run = runRoadmap({}, { values: [val('ldlC', 4.1, 'mmol/L')], sex: 'male', height: { value: 70, unit: 'in' } });
    expect(run.applied).toContain('heightCm');
    expect(ctx(run.contextJson).profile.heightCm).toBeCloseTo(177.8, 1);
    expect(ctx(run.contextJson).derivedValues.bmi ?? null).toBeNull();
  });
  it('a bare heightCm is not read; a height with no or an unknown unit is rejected', () => {
    const bare = runRoadmap({}, { values: [], sex: 'male', heightCm: 70 });
    expect(bare.applied).toEqual(['sex']);
    expect(bare.contextJson).toBeNull();
    const noUnit = runRoadmap(PROFILE, { values: [], height: { value: 70 } });
    expect(noUnit.rejected).toEqual([{ field: 'heightCm', reason: 'value or unit missing or not a number' }]);
    const badUnit = runRoadmap(PROFILE, { values: [], height: { value: 5.8, unit: 'ft' } });
    expect(badUnit.rejected).toEqual([{ field: 'heightCm', reason: 'unit not recognised for this field: ask the user which unit' }]);
    expect(ctx(badUnit.contextJson).profile.heightCm).toBe(178);
  });
  it('the tool schema takes height as a value and a unit', () => {
    const height = RUN_ROADMAP_TOOL.input_schema.properties.height;
    expect(height.properties.unit.enum).toEqual(['cm', 'in']);
    expect(RUN_ROADMAP_TOOL.input_schema.properties).not.toHaveProperty('heightCm');
  });
});

describe('US-15 AC33: a stated age never lifts a saved known minor (C6)', () => {
  it('the saved minor stays a minor', () => {
    const minor = { ...PROFILE, birthYear: new Date().getFullYear() - 14 };
    const run = runRoadmap(minor, { values: [], age: 36 });
    expect(run.applied).toEqual([]);
    expect(run.rejected).toEqual([{ field: 'age', reason: 'the saved profile is under 18: a stated age or birth year is not used' }]);
    expect(ctx(run.contextJson).profile.knownMinor).toBe(true);
  });
  it('an adult\'s stated age is still used', () => {
    expect(runRoadmap(PROFILE, { values: [], age: 46 }).applied).toEqual(['age']);
  });
});

describe('US-15 AC33: one run_roadmap per turn (S1) and honest stubs (S5)', () => {
  const NOT_RUN = 'Not run: one run_roadmap per turn; use the first result.';
  const use = (id: string, name: string, input: unknown) => ({ type: 'tool_use', id, name, input });

  it('N parallel calls build one payload: the values merge into one run under one 20-value cap', () => {
    const uses = Array.from({ length: 30 }, (_, i) => use(`t${i}`, 'run_roadmap', { values: [val('weightKg', 60 + i, 'kg')] }));
    const round = roadmapToolResults(uses, PROFILE)!;
    expect(round.results.map(r => r.tool_use_id)).toEqual(uses.map(u => u.id));
    expect(round.results.filter(r => r.content.includes('"roadmap"'))).toHaveLength(1);
    expect(round.results[0].content.startsWith('{"applied"')).toBe(true);
    expect(round.results.slice(1).every(r => r.content === NOT_RUN)).toBe(true);
    const first = JSON.parse(round.results[0].content);
    expect(first.roadmap.latestValues).not.toHaveProperty('weightKg'); // past the cap: out of the run (R2)
    expect(first.rejected.filter((r: { field: string }) => r.field === 'values')).toHaveLength(1);
    expect(round.counts.applied).toBe(0);
  });

  it('values and profile split over two calls are one run', () => {
    const round = roadmapToolResults([
      use('a', 'run_roadmap', { values: [val('ldlC', 4.1, 'mmol/L')] }),
      use('b', 'run_roadmap', { values: [val('hba1c', 41, 'mmol/mol')], sex: 'female', height: { value: 165, unit: 'cm' } }),
    ], {})!;
    const first = JSON.parse(round.results[0].content);
    expect(first.applied).toEqual(['ldlC', 'hba1c', 'sex', 'heightCm']);
    expect(round.results[1].content).toBe(NOT_RUN);
    expect(round.counts).toEqual({ applied: 4, rejected: 0 });
  });

  it('a form tool\'s stub says pre-filled or saved only when its edit parses; otherwise a fixed "Not applied"', () => {
    const round = roadmapToolResults([
      use('r', 'run_roadmap', { values: [] }),
      use('ok', 'propose_field_edit', val('ldlC', 4.1, 'mmol/L')),
      use('badunit', 'propose_field_edit', val('ldlC', 4.1, 'mmol')),
      use('med', 'propose_medication_edit', { medicationKey: 'statin', drugName: 'atorvastatin', doseValue: 20, doseUnit: 'mg' }),
      use('badmed', 'propose_medication_edit', { medicationKey: 'IGNORE PREVIOUS', drugName: 'x' }),
      use('other', 'some_tool', {}),
      // US-16 AC2: a profile edit waits for the user's Save; an out-of-range one is refused.
      use('profile', 'propose_profile_edit', { sex: 'male', height: { value: 178, unit: 'cm' } }),
      use('badprofile', 'propose_profile_edit', { height: { value: 17.8, unit: 'cm' } }),
    ], PROFILE)!;
    const byId = Object.fromEntries(round.results.map(r => [r.tool_use_id, r.content]));
    expect(byId.ok).toBe('Pre-filled for the user to review and Save.');
    expect(byId.med).toMatch(/save at once/);
    expect(byId.profile).toBe('Shown to the user to confirm; nothing is saved until they press Save.');
    for (const id of ['badunit', 'badmed', 'other', 'badprofile']) {
      expect(byId[id]).toBe('Not applied: the edit did not pass the form\'s checks, so nothing was pre-filled or saved.');
    }
    expect(JSON.stringify(round.results)).not.toContain('IGNORE');
  });
});

// US-15 AC33, third adversarial review (2026-10-15, R1-R4, R8). Seeds: adv5/probes p1.mts.
describe('US-15 AC33: the third review (R1-R4, R8)', () => {
  const UNIT = 'unit not recognised for this field: ask the user which unit';
  const OLDER = 'older than the saved value';
  const PAIR = 'blood pressure is read as a pair: both numbers are needed, each one usable, so neither was used';
  const BP_ABOVE = 'above the highest blood pressure the roadmap records: treat it as a possible emergency and advise urgent medical care';
  const BP_BELOW = 'below the lowest blood pressure the roadmap records: treat it as possibly dangerous and advise urgent medical care if they feel faint, dizzy or unwell';
  const LAB_ABOVE = 'above the highest value the roadmap records in this unit: ask the user to confirm the value and unit; if it is right, suggest they discuss it with their doctor';
  const BODY = 'outside what the roadmap records: ask the user to check the value and unit';
  const SAVED = {
    ...PROFILE, creatinine: 80,
    measurementHistory: {
      hba1c: [{ date: '2026-09-01', value: 34 }], creatinine: [{ date: '2026-09-01', value: 80 }],
      systolic_bp: [{ date: '2026-10-01', value: 118 }], diastolic_bp: [{ date: '2026-10-01', value: 76 }],
    },
  };
  const NOW = new Date('2026-10-15T03:00:00Z');
  const run = (input: unknown, base: unknown = SAVED) => runRoadmap(base, input, NOW);
  const latest = (r: ReturnType<typeof runRoadmap>) => ctx(r.contextJson).latestValues;

  it.each([
    ['hba1c', 6.1, 'mmol/mol', 'hba1c', '34'], ['hba1c', 12, 'mmol/mol', 'hba1c', '34'],
    ['creatinine', 15, 'µmol/L', 'creatinine', '80'], ['creatinine', 1.1, 'µmol/L', 'creatinine', '80'],
  ])('R1: %s %s %s is in the ask-unit band: the unit reason, and the saved value no longer answers (fourth review, adversary R2)', (field, value, unit, key) => {
    const r = run({ values: [val(field, value, unit)] });
    expect(r.applied).toEqual([]);
    expect(r.rejected[0]).toEqual({ field, reason: UNIT });
    // A refused creatinine also withholds the protein card (Codex round 2).
    expect(r.rejected.slice(1)).toEqual(field === 'creatinine' ? [{ field, reason: 'the protein target depends on kidney function, which this run could not work out, so it is left out until the refused value is confirmed' }] : []);
    expect(latest(r)).not.toHaveProperty(key);
  });

  it('R1: HbA1c and creatinine at 20 (SI) are read', () => {
    expect(run({ values: [val('hba1c', 20, 'mmol/mol'), val('creatinine', 20, 'µmol/L')] }).applied).toEqual(['hba1c', 'creatinine']);
  });

  it('R2: blood pressure above or below the range gets its own reason, and the saved pair is removed', () => {
    const high = run({ values: [val('systolicBp', 260, 'mmHg'), val('diastolicBp', 155, 'mmHg')] });
    expect(high.rejected).toEqual([{ field: 'systolicBp', reason: BP_ABOVE }, { field: 'diastolicBp', reason: BP_ABOVE }]);
    const low = run({ values: [val('systolicBp', 55, 'mmHg'), val('diastolicBp', 35, 'mmHg')] });
    expect(low.rejected).toEqual([{ field: 'systolicBp', reason: BP_BELOW }, { field: 'diastolicBp', reason: BP_BELOW }]);
    for (const r of [high, low]) {
      expect(latest(r)).not.toHaveProperty('systolicBp');
      expect(latest(r)).not.toHaveProperty('diastolicBp');
      expect(ctx(r.contextJson).measurementHistory ?? {}).not.toHaveProperty('systolic_bp');
    }
  });

  it('R2: a lab above its range in the stated unit: confirm the unit; the saved value is removed', () => {
    const r = run({ values: [val('hba1c', 48, '%'), val('creatinine', 90, 'mg/dL')] });
    expect(r.rejected).toEqual([{ field: 'hba1c', reason: LAB_ABOVE }, { field: 'creatinine', reason: LAB_ABOVE }, { field: 'creatinine', reason: 'the protein target depends on kidney function, which this run could not work out, so it is left out until the refused value is confirmed' }]);
    expect(latest(r)).not.toHaveProperty('hba1c');
    expect(latest(r)).not.toHaveProperty('creatinine');
    expect(ctx(r.contextJson).measurementHistory ?? {}).not.toHaveProperty('hba1c');
    expect(latest(r).ldlC).toBe('2.4');
  });

  it('R2: weight and waist out of range: check the value and unit; the saved value is removed', () => {
    const r = run({ values: [val('weightKg', 10, 'kg'), val('waistCm', 400, 'cm')] });
    expect(r.rejected).toEqual([{ field: 'weightKg', reason: BODY }, { field: 'waistCm', reason: BODY }]);
    expect(latest(r)).not.toHaveProperty('weightKg');
    expect(latest(r)).not.toHaveProperty('waistCm');
  });

  it('R2: a stated height out of range: check the value and unit; the saved height stays, so the plan still runs', () => {
    const r = run({ values: [], height: { value: 900, unit: 'cm' } });
    expect(r.rejected).toEqual([{ field: 'heightCm', reason: BODY }]);
    expect(r.contextJson).not.toBeNull();
  });

  it('R3: systolic and diastolic stated on different days are not a pair: both refused, the saved pair removed', () => {
    const r = run({ values: [val('systolicBp', 150, 'mmHg', '2026-10-10'), val('diastolicBp', 100, 'mmHg', '2026-10-10'), val('systolicBp', 125, 'mmHg', '2026-10-12')] });
    expect(r.applied).toEqual([]);
    expect(r.rejected).toEqual([
      { field: 'systolicBp', reason: 'a later value for the same field was used' },
      { field: 'systolicBp', reason: PAIR }, { field: 'diastolicBp', reason: PAIR },
    ]);
    expect(latest(r)).not.toHaveProperty('systolicBp');
    expect(latest(r)).not.toHaveProperty('diastolicBp');
  });

  it('R3: an older systolic beside an undated diastolic is not outdated: both refused, the saved pair removed', () => {
    const r = run({ values: [val('systolicBp', 150, 'mmHg', '2026-09-01'), val('diastolicBp', 95, 'mmHg')] });
    expect(r.applied).toEqual([]);
    expect(r.rejected).toEqual([{ field: 'systolicBp', reason: OLDER }, { field: 'diastolicBp', reason: PAIR }]);
    expect(latest(r)).not.toHaveProperty('systolicBp');
    expect(latest(r)).not.toHaveProperty('diastolicBp');
  });

  it('R3/R4: a pair both older than the saved one keeps the saved pair, even out of range (260/155 in 2020)', () => {
    const r = run({ values: [val('systolicBp', 260, 'mmHg', '2020-01-01'), val('diastolicBp', 155, 'mmHg', '2020-01-01')] });
    expect(r.applied).toEqual([]);
    expect(r.rejected).toEqual([{ field: 'systolicBp', reason: OLDER }, { field: 'diastolicBp', reason: OLDER }]);
    expect(latest(r)).toMatchObject({ systolicBp: '118', diastolicBp: '76' });
  });

  it('R4: a dated old lab out of range never strips the newer saved value', () => {
    const r = run({ values: [val('hba1c', 300, 'mmol/mol', '2020-01-01')] });
    expect(r.rejected).toEqual([{ field: 'hba1c', reason: OLDER }]);
    expect(latest(r).hba1c).toBe('34');
  });

  it('R8: a bare heightCm is refused with the shape reason, through the tool path too', () => {
    const bare = run({ values: [], sex: 'male', heightCm: 70 }, {});
    expect(bare.rejected).toEqual([{ field: 'heightCm', reason: 'value or unit missing or not a number' }]);
    expect(bare.contextJson).toBeNull();
    const round = roadmapToolResults([{ type: 'tool_use', id: 'a', name: 'run_roadmap', input: { values: [], sex: 'male', heightCm: 70 } }], {})!;
    expect(JSON.parse(round.results[0].content).rejected).toEqual([{ field: 'heightCm', reason: 'value or unit missing or not a number' }]);
  });
});

describe('US-15 AC33: the fourth review (Codex R1; adversary R2, R3, R7)', () => {
  const NOW = new Date('2026-10-15T03:00:00Z');
  const SAVED = {
    ...PROFILE, ldlC: 2.0,
    measurementHistory: {
      ldl: [{ date: '2026-09-01', value: 2.0 }],
      systolic_bp: [{ date: '2026-10-01', value: 118 }], diastolic_bp: [{ date: '2026-10-01', value: 76 }],
    },
  };
  const run = (input: unknown, base: unknown = SAVED) => runRoadmap(base, input, NOW);
  const latest = (r: ReturnType<typeof runRoadmap>) => ctx(r.contextJson).latestValues;
  const history = (r: ReturnType<typeof runRoadmap>) => ctx(r.contextJson).measurementHistory ?? {};
  const SUPERSEDED = 'a later or same-day value for this field could not be used, so this one was not used either';
  const bpOut = (r: ReturnType<typeof runRoadmap>) => {
    expect(r.applied).toEqual([]);
    expect(latest(r)).not.toHaveProperty('systolicBp');
    expect(latest(r)).not.toHaveProperty('diastolicBp');
    expect(history(r)).not.toHaveProperty('systolic_bp');
    expect(history(r)).not.toHaveProperty('diastolic_bp');
  };

  // Codex R1: a newer out-of-range value invalidates older stated ones for that field.
  const OLD_PAIR = [val('systolicBp', 128, 'mmHg', '2026-10-14'), val('diastolicBp', 82, 'mmHg', '2026-10-14')];
  const NEW_CRISIS = [val('systolicBp', 260, 'mmHg', '2026-10-15'), val('diastolicBp', 155, 'mmHg', '2026-10-15')];
  it.each([['older first', [...OLD_PAIR, ...NEW_CRISIS]], ['newer first', [...NEW_CRISIS, ...OLD_PAIR]]])(
    'R1: BP 128/82 on 2026-10-14 then 260/155 on 2026-10-15 (%s): neither the older pair nor the saved one answers', (_, values) => {
      const r = run({ values });
      bpOut(r);
      expect(r.contextJson).not.toContain('128');
      expect(r.rejected).toEqual(expect.arrayContaining([
        { field: 'systolicBp', reason: SUPERSEDED }, { field: 'diastolicBp', reason: SUPERSEDED },
      ]));
    });

  it('R1: an out-of-range BP on the same day as an in-range one invalidates it too (undated is today)', () => {
    bpOut(run({ values: [val('systolicBp', 128, 'mmHg'), val('diastolicBp', 82, 'mmHg'), val('systolicBp', 260, 'mmHg'), val('diastolicBp', 155, 'mmHg')] }));
  });

  it.each([
    ['older first', [val('ldlC', 3.1, 'mmol/L', '2026-10-14'), val('ldlC', 41, 'mmol/L', '2026-10-15')]],
    ['newer first', [val('ldlC', 41, 'mmol/L', '2026-10-15'), val('ldlC', 3.1, 'mmol/L', '2026-10-14')]],
    ['same day', [val('ldlC', 3.1, 'mmol/L', '2026-10-14'), val('ldlC', 41, 'mmol/L', '2026-10-14')]],
  ])('R1: LDL 3.1 then an out-of-range 41 (%s): the field is out of the run', (_, values) => {
    const r = run({ values });
    expect(r.applied).toEqual([]);
    expect(r.rejected).toContainEqual({ field: 'ldlC', reason: SUPERSEDED });
    expect(latest(r)).not.toHaveProperty('ldlC');
    expect(history(r)).not.toHaveProperty('ldl');
  });

  it('R1: an older out-of-range value does not stop a newer usable one', () => {
    const r = run({ values: [val('ldlC', 41, 'mmol/L', '2026-10-14'), val('ldlC', 3.1, 'mmol/L', '2026-10-15')] });
    expect(r.applied).toEqual(['ldlC']);
    expect(latest(r).ldlC).toBe('3.1');
  });

  // Adversary R2: a stated value refused for date, shape, unit or the ask-unit band takes its field out of the run.
  it('R2: saved LDL 2.0, stated LDL 4.9 dated in the future: the saved LDL does not answer', () => {
    const r = run({ values: [val('ldlC', 4.9, 'mmol/L', '2026-12-01')] });
    expect(r.rejected).toEqual([{ field: 'ldlC', reason: 'not a real date, or a date in the future' }]);
    expect(latest(r)).not.toHaveProperty('ldlC');
    expect(history(r)).not.toHaveProperty('ldl');
  });

  it.each([
    ['an unknown unit', val('ldlC', 4.9, 'mmol')],
    ['a missing unit', { field: 'ldlC', value: 4.9 }],
    ['a number that is not one', { field: 'ldlC', value: 'high', unit: 'mmol/L' }],
    ['the unit-swap floor', val('ldlC', 3.4, 'mg/dL')],
    ['an impossible date', val('ldlC', 4.9, 'mmol/L', '2026-02-30')],
  ])('R2: %s: the saved LDL does not answer', (_, item) => {
    const r = run({ values: [item] });
    expect(r.applied).toEqual([]);
    expect(latest(r)).not.toHaveProperty('ldlC');
  });

  it('R2: the HbA1c ask-unit band takes the saved HbA1c out too', () => {
    const r = run({ values: [val('hba1c', 6.1, 'mmol/mol')] });
    expect(r.rejected).toEqual([{ field: 'hba1c', reason: 'unit not recognised for this field: ask the user which unit' }]);
    expect(latest(r)).not.toHaveProperty('hba1c');
  });

  it('R2: a refused value beside a usable one from the same day takes both out; an earlier refused one does not', () => {
    expect(latest(run({ values: [val('ldlC', 4.1, 'mmol/L'), val('ldlC', 4.9, 'mmol')] }))).not.toHaveProperty('ldlC');
    const r = run({ values: [val('ldlC', 4.9, 'mmol', '2026-10-10'), val('ldlC', 4.1, 'mmol/L', '2026-10-12')] });
    expect(r.applied).toEqual(['ldlC']);
    expect(latest(r).ldlC).toBe('4.1');
  });

  it('R2: a BP number refused for its unit takes the whole pair out, through the pair rule', () => {
    const r = run({ values: [val('systolicBp', 130, 'mmHg'), val('diastolicBp', 85, 'mm')] });
    bpOut(r);
    expect(r.rejected).toEqual([
      { field: 'diastolicBp', reason: 'unit not recognised for this field: ask the user which unit' },
      { field: 'systolicBp', reason: 'blood pressure is read as a pair: both numbers are needed, each one usable, so neither was used' },
    ]);
  });

  it('R2 exceptions: an older value, even with a bad unit, keeps the newer saved one; a superseded duplicate is harmless', () => {
    const older = run({ values: [val('ldlC', 5.2, 'mmol', '2026-08-01')] });
    expect(older.rejected).toEqual([{ field: 'ldlC', reason: 'older than the saved value' }]);
    expect(latest(older).ldlC).toBe('2');
    const later = run({ values: [val('ldlC', 3.1, 'mmol/L', '2026-10-10'), val('ldlC', 3.3, 'mmol/L', '2026-10-12')] });
    expect(later.rejected).toEqual([{ field: 'ldlC', reason: 'a later value for the same field was used' }]);
    expect(latest(later).ldlC).toBe('3.3');
  });

  // Adversary R3: the tool takes an age; runRoadmap derives the birth year from today.
  it('R3: the tool takes age in whole years, or a birth year only as stated', () => {
    const props = RUN_ROADMAP_TOOL.input_schema.properties as Record<string, { type?: string; description?: string }>;
    expect(props.age.type).toBe('integer');
    expect(props.birthYear.type).toBe('integer');
    expect(props.birthYear.description).toMatch(/do not compute/i);
    expect(RUN_ROADMAP_TOOL.description).toContain('age');
  });

  it('R3: a stated age gives the plan that age, from today\'s date', () => {
    const r = runRoadmap({}, { values: [val('ldlC', 4.1, 'mmol/L')], sex: 'male', height: { value: 180, unit: 'cm' }, age: 55 });
    expect(r.applied).toEqual(['ldlC', 'sex', 'heightCm', 'age']);
    expect(ctx(r.contextJson).profile.age).toBe(55);
    expect(ctx(r.contextJson).profile).not.toHaveProperty('knownMinor');
  });

  it('R3: age 17 is a minor; age 18 is not', () => {
    const at = (age: number) => ctx(runRoadmap({}, { values: [], sex: 'female', height: { value: 165, unit: 'cm' }, age }).contextJson).profile;
    expect(at(17).knownMinor).toBe(true);
    expect(at(18)).not.toHaveProperty('knownMinor');
    expect(at(18).age).toBe(18);
  });

  it('R3: a saved known minor stays one whatever age is stated; a bad age is refused', () => {
    const minor = { ...PROFILE, birthYear: new Date().getFullYear() - 14 };
    const r = runRoadmap(minor, { values: [], age: 40 });
    expect(r.rejected).toEqual([{ field: 'age', reason: 'the saved profile is under 18: a stated age or birth year is not used' }]);
    expect(ctx(r.contextJson).profile.knownMinor).toBe(true);
    for (const age of [-3, 200, 'forty', true]) {
      expect(runRoadmap(PROFILE, { values: [], age }).rejected).toEqual([{ field: 'age', reason: 'out of range for this field' }]);
    }
  });

  it('R3: a stated age replaces the saved birth year and month', () => {
    const r = runRoadmap(PROFILE, { values: [], age: 40 });
    expect(r.contextJson).toBe(buildChatContextJson({ ...PROFILE, birthYear: new Date().getFullYear() - 40, birthMonth: 1 }));
    expect(ctx(r.contextJson).profile.age).toBe(40);
  });

  // Adversary R7: the HbA1c and creatinine ask-unit band is for their SI unit only.
  it('R7: HbA1c 3.9 % (19.1 mmol/mol) and creatinine 0.2 mg/dL (17.7 µmol/L) are read, not refused as a unit', () => {
    const r = run({ values: [val('hba1c', 3.9, '%'), val('creatinine', 0.2, 'mg/dL')] });
    expect(r.rejected).toEqual([]);
    expect(r.applied).toEqual(['hba1c', 'creatinine']);
  });

  it('R7: HbA1c 6.1 mmol/mol and creatinine 15 µmol/L stay in the ask-unit band', () => {
    const r = run({ values: [val('hba1c', 6.1, 'mmol/mol'), val('creatinine', 15, 'µmol/L')] });
    expect(r.rejected.map(x => x.reason)).toEqual(['unit not recognised for this field: ask the user which unit', 'unit not recognised for this field: ask the user which unit', 'the protein target depends on kidney function, which this run could not work out, so it is left out until the refused value is confirmed']);
  });
});

// US-15 AC33, fifth pass (2026-10-16): the reverse of R3 ("born 1974" needs no
// arithmetic by a model that may not know today's date) and the 20-value cap.
describe('US-15 AC33: a stated birth year, and values past the cap', () => {
  const MINOR = 'the saved profile is under 18: a stated age or birth year is not used';

  it('a stated birth year is used as stated, with no month', () => {
    const r = runRoadmap({}, { values: [], sex: 'female', height: { value: 165, unit: 'cm' }, birthYear: 1974 });
    expect(r.applied).toEqual(['sex', 'heightCm', 'birthYear']);
    expect(r.contextJson).toBe(buildChatContextJson({ sex: 'female', heightCm: 165, birthYear: 1974 }));
  });

  it('a different stated birth year drops the saved month; the same year keeps it', () => {
    expect(runRoadmap(PROFILE, { values: [], birthYear: 1974 }).contextJson)
      .toBe(buildChatContextJson({ ...PROFILE, birthYear: 1974, birthMonth: undefined }));
    expect(runRoadmap(PROFILE, { values: [], birthYear: 1972 }).contextJson).toBe(buildChatContextJson(PROFILE));
  });

  // US-15 AC33 follow-up (2026-10-18, Brad): a malformed age used to hide a usable birth year.
  it('a refused age falls back to a usable stated birth year', () => {
    const born = new Date().getFullYear() - 16;
    const { birthYear: _y, birthMonth: _m, ...noAge } = PROFILE;
    for (const age of ['x', -1, 200]) {
      const fresh = runRoadmap(noAge, { values: [], age, birthYear: born });
      expect(fresh.applied).toEqual(['birthYear']);
      expect(fresh.rejected).toEqual([{ field: 'age', reason: 'out of range for this field' }]);
      expect(ctx(fresh.contextJson).profile.knownMinor).toBe(true);
      const adult = runRoadmap(PROFILE, { values: [], age, birthYear: 1980 });
      expect(adult.applied).toEqual(['birthYear']);
      expect(adult.contextJson).toBe(buildChatContextJson({ ...PROFILE, birthYear: 1980, birthMonth: undefined }));
    }
    // Both refused: both named, and the saved birth year stays.
    const neither = runRoadmap(PROFILE, { values: [], age: 'x', birthYear: 1700 });
    expect(neither.rejected).toEqual([{ field: 'age', reason: 'out of range for this field' }, { field: 'birthYear', reason: 'out of range for this field' }]);
    expect(neither.contextJson).toBe(buildChatContextJson(PROFILE));
    // A saved known minor refuses both.
    const minor = { ...PROFILE, birthYear: new Date().getFullYear() - 14 };
    expect(runRoadmap(minor, { values: [], age: 'x', birthYear: 1970 }).rejected).toEqual([{ field: 'age', reason: MINOR }, { field: 'birthYear', reason: MINOR }]);
  });

  it('age wins when both are given; a saved minor refuses a birth year; a bad one is refused', () => {
    const both = runRoadmap({}, { values: [], sex: 'male', height: { value: 180, unit: 'cm' }, age: 55, birthYear: 1950 });
    expect(both.applied).toEqual(['sex', 'heightCm', 'age']);
    expect(ctx(both.contextJson).profile.age).toBe(55);
    const minor = { ...PROFILE, birthYear: new Date().getFullYear() - 14 };
    expect(runRoadmap(minor, { values: [], birthYear: 1970 }).rejected).toEqual([{ field: 'birthYear', reason: MINOR }]);
    for (const birthYear of [1974.5, 1700, 'nineteen seventy-four']) {
      expect(runRoadmap(PROFILE, { values: [], birthYear }).rejected).toEqual([{ field: 'birthYear', reason: 'out of range for this field' }]);
    }
  });

  it('a field stated only past the cap is taken out of the run, so the saved value never answers for it', () => {
    const values = [...Array.from({ length: RUN_ROADMAP_MAX_VALUES }, (_, i) => val('weightKg', 60 + i, 'kg')), val('ldlC', 4.9, 'mmol/L')];
    const r = runRoadmap(PROFILE, { values });
    expect(r.rejected).toContainEqual({ field: 'values', reason: `only the first ${RUN_ROADMAP_MAX_VALUES} values were used` });
    expect(r.rejected).toContainEqual({ field: 'ldlC', reason: `only the first ${RUN_ROADMAP_MAX_VALUES} values were used` });
    expect(ctx(r.contextJson).latestValues).not.toHaveProperty('ldlC');
  });
});

// US-15 AC33, Codex round 2 (2026-10-16): without creatinine the protein card
// falls back to the standard target, so a refused creatinine must not quietly
// drop a saved kidney adjustment. The card is withheld until the value is clear.
describe('US-15 AC33: a refused creatinine withholds the kidney-adjusted protein target', () => {
  const KIDNEY = { ...PROFILE, creatinine: 200 }; // eGFR under 45: protein at 1.0 g/kg
  const cards = (json: string | null) => ctx(json).currentSuggestions.map((s: { id: string }) => s.id);

  it('saved impaired kidney function plus a refused creatinine: no protein card, and the reason says why', () => {
    expect(cards(buildChatContextJson(KIDNEY))).toContain('protein-target');
    for (const values of [[val('creatinine', 3000, 'µmol/L')], [val('creatinine', 150, 'mmol')], [val('creatinine', 150, 'µmol/L', '2026-13-01')]]) {
      const r = runRoadmap(KIDNEY, { values });
      expect(cards(r.contextJson)).not.toContain('protein-target');
      expect(ctx(r.contextJson).latestValues).not.toHaveProperty('creatinine');
      expect(r.rejected).toContainEqual({ field: 'creatinine', reason: expect.stringMatching(/protein target .* left out/) });
    }
  });

  it('a usable stated creatinine, or none at all, keeps the protein card', () => {
    expect(cards(runRoadmap(KIDNEY, { values: [val('creatinine', 90, 'µmol/L')] }).contextJson)).toContain('protein-target');
    expect(cards(runRoadmap(KIDNEY, { values: [val('ldlC', 3.1, 'mmol/L')] }).contextJson)).toContain('protein-target');
  });
});

// US-15 AC33, adversary round 2 (2026-10-16): R1, R2, R4, R8.
describe('US-15 AC33: older BP numbers, the cap, and a refused age or sex', () => {
  const SAVED_BP = { ...PROFILE, systolicBp: 150, diastolicBp: 95, measurementHistory: { systolic_bp: [{ date: '2026-10-01', value: 150 }], diastolic_bp: [{ date: '2026-10-01', value: 95 }] } };
  const cards = (json: string | null) => ctx(json).currentSuggestions.map((s: { id: string }) => s.id);

  it('R1: one stated BP number older than the saved reading leaves the saved pair standing', () => {
    for (const field of ['systolicBp', 'diastolicBp']) {
      const r = runRoadmap(SAVED_BP, { values: [val(field, field === 'systolicBp' ? 120 : 70, 'mmHg', '2026-01-05')] });
      expect(r.rejected).toEqual([{ field, reason: 'older than the saved value' }]);
      expect(ctx(r.contextJson).latestValues).toMatchObject({ systolicBp: '150', diastolicBp: '95' });
      expect(cards(r.contextJson)).toContain('bp-stage2');
    }
  });

  it('R2: a field with any value past the cap is out of the run, even if an earlier one was read', () => {
    const fill = Array.from({ length: RUN_ROADMAP_MAX_VALUES - 1 }, (_, i) => val('weightKg', 60 + i, 'kg', '2026-10-01'));
    const r = runRoadmap(PROFILE, { values: [val('hba1c', 49, 'mmol/mol', '2025-06-01'), ...fill, val('hba1c', 36, 'mmol/mol', '2026-06-01')] });
    expect(ctx(r.contextJson).latestValues).not.toHaveProperty('hba1c');
    expect(cards(r.contextJson)).not.toContain('hba1c-diabetic');
  });

  // Simplified 2026-10-16 (Option A, Brad): with ages rounded down, a refused age is
  // only nonsense (-1, 200, a word), so the saved age and sex stay. Removing them lost
  // the inputs eGFR needs, and with them the kidney-adjusted protein target.
  it('a refused age, birth year or sex keeps the saved one', () => {
    for (const input of [{ age: -1 }, { age: 'sixteen' }, { birthYear: 2009.5 }, { sex: 'Female' }]) {
      const r = runRoadmap(PROFILE, { values: [val('ldlC', 4.5, 'mmol/L')], ...input });
      expect(r.rejected.map(x => x.reason)).toContain('out of range for this field');
      expect(ctx(r.contextJson).profile).toMatchObject({ sex: 'male', age: ctx(buildChatContextJson(PROFILE)).profile.age });
    }
  });
});

// US-15 AC33: the protein card is left out only when this run has no eGFR although the
// saved data had one, or a creatinine was stated (Codex rounds 2-3, adversary round 4).
describe('US-15 AC33: the protein target is withheld only when the run loses kidney function', () => {
  const KIDNEY = { ...PROFILE, creatinine: 200 };
  const cards = (json: string | null) => (json ? ctx(json).currentSuggestions : []).map((s: { id: string }) => s.id);
  const card = (json: string | null) => ctx(json).currentSuggestions.find((s: { id: string }) => s.id === 'protein-target');
  const PROTEIN = 'the protein target depends on kidney function, which this run could not work out, so it is left out until the refused value is confirmed';
  const NEEDS_AGE = 'the protein target depends on kidney function, which needs the user\'s age: ask for their age';

  it('a saved creatinine with nothing refused: the card shows, kidney-adjusted', () => {
    const r = runRoadmap(KIDNEY, { values: [val('ldlC', 3.1, 'mmol/L')] });
    expect(card(r.contextJson).description).toMatch(/adjusted for kidney function/);
    expect(r.rejected).toEqual([]);
  });

  it('a refused age, birth year or sex keeps the saved kidney adjustment', () => {
    for (const input of [{ age: 200 }, { birthYear: 1972.5 }, { sex: 'Male' }]) {
      const r = runRoadmap(KIDNEY, { values: [val('ldlC', 3.1, 'mmol/L')], ...input });
      expect(card(r.contextJson).description).toMatch(/adjusted for kidney function/);
      expect(r.rejected.map(x => x.reason)).not.toContain(PROTEIN);
    }
  });

  // US-15 AC33 follow-up (2026-10-18, Brad): when the gap is the age, not a refused value,
  // the reason asks for the age instead of waiting on a value that was never refused.
  it('a stated creatinine with no saved birth year: no card, and the reason asks for the age', () => {
    const { birthYear: _y, birthMonth: _m, ...noAge } = PROFILE;
    for (const input of [{}, { age: 200 }]) {
      const r = runRoadmap(noAge, { values: [val('creatinine', 200, 'µmol/L')], ...input });
      expect(r.applied).toContain('creatinine');
      expect(cards(r.contextJson)).not.toContain('protein-target');
      expect(r.rejected).toContainEqual({ field: 'age', reason: NEEDS_AGE });
      expect(r.rejected.map(x => x.reason)).not.toContain(PROTEIN);
    }
  });

  it('a refused creatinine keeps the refused-value reason, with or without an age', () => {
    const { birthYear: _y, birthMonth: _m, ...noAge } = KIDNEY;
    for (const profile of [KIDNEY, noAge]) {
      const r = runRoadmap(profile, { values: [val('creatinine', 3000, 'µmol/L')] });
      expect(cards(r.contextJson)).not.toContain('protein-target');
      expect(r.rejected).toContainEqual({ field: 'creatinine', reason: PROTEIN });
      expect(r.rejected.map(x => x.reason)).not.toContain(NEEDS_AGE);
    }
  });

  it('no sex or height: no plan, and no protein reason (US-15 AC36 sends the values, but run_roadmap still answers no plan)', () => {
    const r = runRoadmap({}, { values: [val('creatinine', 90, 'µmol/L'), val('ldlC', 4.1, 'mmol/L')] });
    expect(r.contextJson).toBeNull();
    expect(r.rejected).toEqual([]);
    expect(JSON.parse(roadmapResultText(r)).note).toMatch(/sex and height/);
  });

  it('a saved creatinine but no saved age, nothing stated about kidneys: the card shows as the saved plan does', () => {
    const { birthYear: _y, birthMonth: _m, ...noAge } = KIDNEY;
    expect(cards(runRoadmap(noAge, { values: [val('ldlC', 3.1, 'mmol/L')] }).contextJson)).toContain('protein-target');
  });

  it('a stated age that makes a saved adult a minor adds no creatinine reason', () => {
    const r = runRoadmap(KIDNEY, { values: [], age: 16 });
    expect(r.rejected).toEqual([]);
  });
});

// US-15 AC33, adversary round 3 (R2): an age that is not a whole number used to be
// refused, so with no saved birth year a 16.5-year-old got adult cards.
describe('US-15 AC33: a stated age is rounded down, never refused for not being whole', () => {
  it('16.5, 17.9 and "16" are minors; 18.2 is an adult', () => {
    const profile = (age: unknown) => ctx(runRoadmap({}, { values: [val('ldlC', 5.2, 'mmol/L')], sex: 'male', height: { value: 175, unit: 'cm' }, age }).contextJson).profile;
    for (const age of [16.5, 17.9, '16']) expect(profile(age).knownMinor).toBe(true);
    // A birth year sent as text is read the same way (adversary round 4, R2).
    const byYear = ctx(runRoadmap({}, { values: [], sex: 'male', height: { value: 175, unit: 'cm' }, birthYear: String(new Date().getFullYear() - 16) }).contextJson).profile;
    expect(byYear.knownMinor).toBe(true);
    expect(profile(18.2)).not.toHaveProperty('knownMinor');
    expect(profile(18.2).age).toBe(18);
  });
});

// US-67 AC4: the iPhone chat's edits, written through the engine's one entry
// (chat-edits.ts) by health-core's own writes. The proposals are built by the
// server's own parser (parseProposedEdit), so these run the path a real reply takes.
import { describe, expect, it } from 'vitest';
import { applyEdit, newRecord } from './my-data';
import { chatEditsJson, applyEditJson } from './entry';
import type { RoadmapFile } from '../../packages/health-core/src/roadmap-file';
import { parseProposedEdit } from '../../packages/health-core/src/chat-edits';
import { localDay } from '../../packages/health-core/src/merge';
import type { ChatEditsPreview } from './chat-edits';
import { chatContextJson } from './app-doors';
import { runRoadmap } from '../../packages/health-core/src/run-roadmap';

const NOW = '2026-11-02T08:00:00.000Z';
const TODAY = localDay(NOW);
const DAY = '2026-10-01';

const field = (f: string, value: number, unit: string, date: string | null = DAY) => parseProposedEdit('propose_field_edit', { field: f, value, unit, ...(date ? { date } : {}) })!;
const med = (medicationKey: string, drugName: string, doseValue?: number) =>
  parseProposedEdit('propose_medication_edit', { medicationKey, drugName, ...(doseValue ? { doseValue, doseUnit: 'mg' } : {}) })!;
const profile = (input: object) => parseProposedEdit('propose_profile_edit', input)!;

const metric = () => newRecord(NOW, 'phone', 'en-NZ', 'Pacific/Auckland');
const us = () => newRecord(NOW, 'phone', 'en-US', 'America/New_York');

function apply(file: RoadmapFile, part: 'medications' | 'review', edits: unknown, today = TODAY) {
  return applyEdit(file, { kind: 'chatEdits', part, edits, today }, NOW);
}
function saved(file: RoadmapFile, part: 'medications' | 'review', edits: unknown): RoadmapFile {
  const outcome = apply(file, part, edits);
  if (!outcome.ok) throw new Error(outcome.message);
  return outcome.file;
}
function preview(file: RoadmapFile, edits: unknown, unitsJson?: string): ChatEditsPreview {
  return JSON.parse(chatEditsJson(JSON.stringify(file), JSON.stringify(edits), NOW, 'phone', TODAY, unitsJson)) as ChatEditsPreview;
}
const active = (file: RoadmapFile, metricType: string) => file.measurements.filter((m) => m.metricType === metricType && m.status === 'active');
const med$ = (file: RoadmapFile, key: string) => file.medications.find((m) => m.medicationKey === key);

describe('US-67 AC4: values from their stated unit to SI', () => {
  it('US-67 AC4: LDL said in mg/dL on a phone showing mmol/L stores mmol/L, and the banner shows mmol/L', () => {
    const edits = [field('ldlC', 130, 'mg/dL')];
    const [row] = active(saved(metric(), 'review', edits), 'ldl');
    expect(row.value).toBeCloseTo(130 / 38.67, 3);
    expect(row.recordedAt.slice(0, 10)).toBe(DAY);
    expect(preview(metric(), edits).review).toEqual({
      lines: [{ text: 'LDL Cholesterol 3.4 mmol/L on 1 Oct', replaces: null }], refusal: null, seen: [['ldl:2026-10-01', null]],
    });
    // The phone's own LDL choice (My data's units) is what the banner shows.
    expect(preview(metric(), edits, '{"ldl":"conventional"}').review!.lines[0].text).toBe('LDL Cholesterol 130 mg/dL on 1 Oct');
  });

  it('US-67 AC4: Lp(a) in nmol/L, mg/dL and mg/L (US-05 AC2) store the same nmol/L', () => {
    for (const [value, unit] of [[125, 'nmol/L'], [50, 'mg/dL'], [500, 'mg/L']] as const) {
      const [row] = active(saved(metric(), 'review', [field('lpa', value, unit)]), 'lpa');
      expect(row.value, unit).toBeCloseTo(125, 6);
    }
  });

  it('US-67 AC4: a value with no date is today\'s', () => {
    const file = saved(metric(), 'review', [field('weightKg', 80, 'kg', null)]);
    expect(active(file, 'weight')[0].recordedAt.slice(0, 10)).toBe(TODAY);
    expect(preview(metric(), [field('weightKg', 180, 'lbs', null)]).review!.lines[0].text).toBe('Weight 81.6 kg today');
  });
});

describe('US-67 AC4: blood pressure is a pair, both or neither', () => {
  it('US-67 AC4: a systolic and a diastolic for one day join into one pair', () => {
    const edits = [field('systolicBp', 128, 'mmHg'), field('weightKg', 80, 'kg'), field('diastolicBp', 82, 'mmHg')];
    const file = saved(metric(), 'review', edits);
    expect(active(file, 'systolic_bp').map((r) => r.value)).toEqual([128]);
    expect(active(file, 'diastolic_bp').map((r) => r.value)).toEqual([82]);
    expect(preview(metric(), edits).review!.lines.map((l) => l.text)).toEqual(['Blood pressure 128/82 mmHg on 1 Oct', 'Weight 80.0 kg on 1 Oct']);
  });

  it('US-67 AC4: a lone systolic refuses the whole part and writes nothing', () => {
    const before = metric();
    const outcome = apply(before, 'review', [field('weightKg', 80, 'kg'), field('systolicBp', 128, 'mmHg')]);
    expect(outcome).toMatchObject({ ok: false, message: 'A blood pressure needs both numbers from the same day. Nothing was saved.' });
    expect(preview(before, [field('systolicBp', 128, 'mmHg')]).review!.refusal).toMatch(/both numbers/);
  });

  it('US-67 AC4: halves from two days are two lone halves', () => {
    expect(apply(metric(), 'review', [field('systolicBp', 128, 'mmHg'), field('diastolicBp', 82, 'mmHg', '2026-10-02')]).ok).toBe(false);
  });

  it('US-67 AC4: a pair the wrong way up refuses (US-02 AC8)', () => {
    expect(apply(metric(), 'review', [field('systolicBp', 80, 'mmHg'), field('diastolicBp', 120, 'mmHg')]).ok).toBe(false);
  });

  it('US-67 AC4: a held pair becomes a correction, named in the banner', () => {
    const held = saved(metric(), 'review', [field('systolicBp', 120, 'mmHg'), field('diastolicBp', 80, 'mmHg')]);
    const edits = [field('systolicBp', 128, 'mmHg'), field('diastolicBp', 82, 'mmHg')];
    expect(preview(held, edits).review!.lines).toEqual([{ text: 'Blood pressure 128/82 mmHg on 1 Oct', replaces: '120/80 mmHg' }]);
    const file = saved(held, 'review', edits);
    expect(active(file, 'systolic_bp').map((r) => r.value)).toEqual([128]);
    expect(file.measurements.filter((r) => r.status === 'entered-in-error')).toHaveLength(2);
  });
});

describe('US-67 AC4: one Save, all or none', () => {
  it('US-67 AC4: one bad value in a batch writes nothing', () => {
    const before = metric();
    const outcome = apply(before, 'review', [field('ldlC', 3.4, 'mmol/L'), field('weightKg', 5000, 'kg')]);
    expect(outcome).toMatchObject({ ok: false, message: 'Weight 5000 kg is outside what the record accepts. Nothing was saved.' });
    expect(before.measurements).toEqual([]);
    expect(preview(before, [field('ldlC', 3.4, 'mmol/L'), field('weightKg', 5000, 'kg')]).review!.refusal).toMatch(/^Weight 5000 kg/);
  });

  it('US-67 AC4: a held day becomes a correction: the old row entered-in-error, the new one names it', () => {
    const held = saved(metric(), 'review', [field('ldlC', 3.1, 'mmol/L')]);
    const old = active(held, 'ldl')[0];
    expect(preview(held, [field('ldlC', 3.4, 'mmol/L')]).review!.lines).toEqual([{ text: 'LDL Cholesterol 3.4 mmol/L on 1 Oct', replaces: '3.1 mmol/L' }]);
    const file = saved(held, 'review', [field('ldlC', 3.4, 'mmol/L')]);
    expect(file.measurements.find((r) => r.id === old.id)!.status).toBe('entered-in-error');
    const [now] = active(file, 'ldl');
    expect(now).toMatchObject({ value: 3.4, correctsId: old.id });
  });

  it('US-67 AC4: the same value again writes nothing and shows nothing', () => {
    const held = saved(metric(), 'review', [field('ldlC', 3.1, 'mmol/L')]);
    expect(preview(held, [field('ldlC', 3.1, 'mmol/L')]).review).toBeNull();
    expect(saved(held, 'review', [field('ldlC', 3.1, 'mmol/L')])).toBe(held);
  });

  it('US-67 AC4: two values for one test and day keep the later', () => {
    const file = saved(metric(), 'review', [field('ldlC', 3.1, 'mmol/L'), field('ldlC', 3.4, 'mmol/L')]);
    expect(active(file, 'ldl').map((r) => r.value)).toEqual([3.4]);
  });

  it('US-67 AC4: a future date is refused', () => {
    const outcome = apply(metric(), 'review', [field('ldlC', 3.4, 'mmol/L', '2099-01-01')]);
    expect(outcome).toMatchObject({ ok: false, message: 'LDL Cholesterol: on 1 Jan 2099 has not happened yet. Nothing was saved.' });
  });

  it('US-67 AC4: a day after the phone\'s own today is refused', () => {
    expect(apply(metric(), 'review', [field('ldlC', 3.4, 'mmol/L', '2026-10-02')], '2026-10-01').ok).toBe(false);
    expect(apply(metric(), 'review', [field('ldlC', 3.4, 'mmol/L')], 'not a day').ok).toBe(false);
  });
});

describe('US-67 AC4: height and sex', () => {
  it('US-67 AC4: height arrives in cm and is written in cm; the banner is in the phone\'s units', () => {
    const edits = [profile({ sex: 'male', height: { value: 70, unit: 'in' } })];
    const file = saved(us(), 'review', edits);
    expect(file.profile.heightCm).toBeCloseTo(177.8, 6);
    expect(file.profile.sex).toBe('male');
    expect(preview(us(), edits).review!.lines).toEqual([
      { text: 'Sex: male', replaces: null },
      { text: 'Height 5 ft 10 in', replaces: null },
    ]);
    expect(preview(metric(), [profile({ height: { value: 178, unit: 'cm' } })]).review!.lines).toEqual([{ text: 'Height 178 cm', replaces: null }]);
  });

  it('US-67 AC4: a profile already holding the value shows and writes nothing', () => {
    const file = saved(metric(), 'review', [profile({ sex: 'female', height: { value: 165, unit: 'cm' } })]);
    expect(preview(file, [profile({ sex: 'female', height: { value: 165.2, unit: 'cm' } })]).review).toBeNull();
    expect(saved(file, 'review', [profile({ sex: 'female' })])).toBe(file);
    expect(preview(file, [profile({ sex: 'male' })]).review!.lines).toEqual([{ text: 'Sex: male', replaces: 'female' }]);
  });
});

describe('US-67 AC3: medications save at once, with Undo', () => {
  /** A record holding a statin and an escalation answer about it. */
  function onStatin(): RoadmapFile {
    let file = metric();
    for (const edit of [
      { kind: 'medication', medicationKey: 'statin', drugName: 'atorvastatin', doseValue: 10, doseUnit: 'mg' },
      { kind: 'medication', medicationKey: 'statin_escalation', drugName: 'not_tolerated' },
    ] as const) {
      const outcome = applyEdit(file, edit, NOW);
      if (!outcome.ok) throw new Error(outcome.message);
      file = outcome.file;
    }
    return file;
  }

  it('US-67 AC4: a new dose writes, resets the escalation answer, and Undo restores both', () => {
    const before = onStatin();
    const edits = [med('statin', 'atorvastatin', 20)];
    const shown = preview(before, edits);
    expect(shown.medications!.lines).toEqual([{ text: 'Statin: Atorvastatin 20 mg' }]);
    expect(shown.review).toBeNull();
    const after = saved(before, 'medications', edits);
    expect(med$(after, 'statin')).toMatchObject({ drugName: 'atorvastatin', doseValue: 20 });
    expect(med$(after, 'statin_escalation')!.drugName).toBe('not_yet');
    const undone = applyEdit(after, shown.medications!.undo as Parameters<typeof applyEdit>[1], NOW);
    expect(undone.ok).toBe(true);
    const back = (undone as { file: RoadmapFile }).file;
    expect(med$(back, 'statin')).toMatchObject({ drugName: 'atorvastatin', doseValue: 10 });
    expect(med$(back, 'statin_escalation')!.drugName).toBe('not_tolerated');
  });

  it('US-67 AC4: an escalation answer the same reply states is kept', () => {
    const after = saved(onStatin(), 'medications', [med('statin', 'rosuvastatin', 10), med('statin_escalation', 'not_tolerated')]);
    expect(med$(after, 'statin_escalation')!.drugName).toBe('not_tolerated');
  });

  it('US-67 AC4: Undo of a key that had no row writes its unanswered value', () => {
    const shown = preview(metric(), [med('ezetimibe', 'yes')]);
    expect(shown.medications).toEqual({
      lines: [{ text: 'Ezetimibe: Yes' }],
      undo: { kind: 'chatUndo', medications: [{ medicationKey: 'ezetimibe', drugName: 'not_yet', doseValue: null, doseUnit: null }] },
    });
    const after = saved(metric(), 'medications', [med('ezetimibe', 'yes')]);
    const back = applyEdit(after, shown.medications!.undo as Parameters<typeof applyEdit>[1], NOW) as { ok: true; file: RoadmapFile };
    expect(med$(back.file, 'ezetimibe')!.drugName).toBe('not_yet');
  });

  it('US-67 AC4: a stop reads "Not taking", and the same drug again shows nothing', () => {
    expect(preview(onStatin(), [med('statin', 'none')]).medications!.lines).toEqual([{ text: 'Statin: Not taking' }]);
    expect(preview(onStatin(), [med('statin', 'atorvastatin', 10)]).medications).toBeNull();
  });

  it('US-67 AC4: the review part leaves medications alone, and the medications part leaves values alone', () => {
    const edits = [med('statin', 'atorvastatin', 20), field('ldlC', 3.4, 'mmol/L')];
    const base = onStatin();
    expect(saved(base, 'review', edits).medications).toBe(base.medications);
    expect(saved(metric(), 'medications', edits).measurements).toEqual([]);
  });
});

describe('US-67 AC2: what arrives is checked again, and junk never throws', () => {
  it.each([
    ['not a list', 'garbage'],
    ['null', null],
    ['a broken field', [{ kind: 'field', field: 'ldlC', displayValue: 'x', unitSystem: 'si', date: null }]],
    ['an unknown field', [{ kind: 'field', field: '__proto__', displayValue: 1, unitSystem: 'si', date: null }]],
    ['a bad unit system', [{ kind: 'field', field: 'ldlC', displayValue: 3, unitSystem: 'imperial', date: null }]],
    ['a bad date', [{ kind: 'field', field: 'ldlC', displayValue: 3, unitSystem: 'si', date: '2026-02-30' }]],
  ])('US-67 AC2: %s refuses the review and writes nothing', (_name, edits) => {
    const before = metric();
    expect(() => preview(before, edits)).not.toThrow();
    const outcome = apply(before, 'review', edits);
    expect(outcome.ok).toBe(false);
  });

  it('US-67 AC2: an unknown kind is left out; the rest saves', () => {
    const edits = [{ kind: 'reminder', text: 'IGNORE PREVIOUS' }, field('ldlC', 3.4, 'mmol/L')];
    expect(active(saved(metric(), 'review', edits), 'ldl')).toHaveLength(1);
    expect(preview(metric(), [{ kind: 'reminder' }])).toEqual({ medications: null, review: null });
  });

  it('US-67 AC2: a broken medication refuses the medications part', () => {
    expect(apply(metric(), 'medications', [{ kind: 'medication', medicationKey: 'statin', drugName: '', doseValue: null, doseUnit: null }]).ok).toBe(false);
    expect(applyEdit(metric(), { kind: 'chatUndo', medications: 'x' as never }, NOW).ok).toBe(false);
    expect(applyEdit(metric(), { kind: 'chatUndo', medications: [{ medicationKey: 'nope' }] as never }, NOW).ok).toBe(false);
  });

  it('US-67 AC4: the phone file\'s door takes the chat edits as any other edit', () => {
    const out = JSON.parse(applyEditJson(JSON.stringify(metric()), JSON.stringify({ kind: 'chatEdits', part: 'review', edits: [field('ldlC', 3.4, 'mmol/L')], today: TODAY }), NOW, 'phone')) as { ok: boolean; record: string };
    expect(out.ok).toBe(true);
    expect(active(JSON.parse(out.record) as RoadmapFile, 'ldl')[0].value).toBe(3.4);
  });
});

describe('US-67 AC1: the app\'s chat context is what run_roadmap reads', () => {
  it('US-67 AC1: chatContextJson\'s output, as guestInputs, gives run_roadmap the saved values and dates', () => {
    let file = saved(metric(), 'review', [field('ldlC', 3.1, 'mmol/L', '2026-09-01'), field('weightKg', 80, 'kg', '2026-09-01')]);
    file = saved(file, 'review', [profile({ sex: 'male', height: { value: 178, unit: 'cm' } })]);
    file = { ...file, profile: { ...file.profile, birthYear: 1972, birthMonth: 5 } };
    const guestInputs = JSON.parse(chatContextJson(JSON.stringify(file), NOW, 'phone'));
    // A stated value newer than the saved one is used; one older than it is not (the app's dated history is read).
    const run = runRoadmap(guestInputs, { values: [{ field: 'ldlC', value: 3.4, unit: 'mmol/L', date: '2026-10-01' }, { field: 'weightKg', value: 90, unit: 'kg', date: '2026-08-01' }] }, new Date(NOW));
    expect(run.applied).toEqual(['ldlC']);
    expect(run.rejected).toEqual([{ field: 'weightKg', reason: 'older than the saved value' }]);
    const plan = JSON.parse(run.contextJson!);
    expect(plan.latestValues).toMatchObject({ ldlC: '3.4', weightKg: '80' });
    expect(plan.profile).toMatchObject({ sex: 'male', heightCm: 178 });
  });
});

describe('US-67 AC3: a Save checks the record still holds what the banner named', () => {
  const review = (edits: unknown, seen?: unknown) => ({ kind: 'chatEdits' as const, part: 'review' as const, edits, today: TODAY, ...(seen !== undefined ? { seen } : null) });
  const STALE = 'Your record changed on another device while this was shown. Nothing was saved.';

  it('US-67 AC4: an unchanged record saves with the banner\'s seen', () => {
    const held = saved(metric(), 'review', [field('ldlC', 3.1, 'mmol/L'), field('systolicBp', 120, 'mmHg'), field('diastolicBp', 80, 'mmHg')]);
    const edits = [field('ldlC', 3.4, 'mmol/L'), field('systolicBp', 128, 'mmHg'), field('diastolicBp', 82, 'mmHg'), profile({ sex: 'male' })];
    const { seen } = preview(held, edits).review!;
    const ldl = active(held, 'ldl')[0].id;
    const [sys, dia] = [active(held, 'systolic_bp')[0].id, active(held, 'diastolic_bp')[0].id];
    expect(seen).toEqual([['ldl:2026-10-01', ldl], ['bp:2026-10-01', [sys, dia]], ['profile:sex', null]]);
    const outcome = applyEdit(held, review(edits, seen), NOW);
    expect(outcome.ok).toBe(true);
    expect(active((outcome as { file: RoadmapFile }).file, 'ldl')[0].value).toBe(3.4);
  });

  it('US-67 AC3: a value another device corrected since the banner is refused, and nothing is written', () => {
    const held = saved(metric(), 'review', [field('ldlC', 3.1, 'mmol/L')]);
    const edits = [field('ldlC', 3.4, 'mmol/L'), field('weightKg', 80, 'kg')];
    const { seen } = preview(held, edits).review!;
    const moved = saved(held, 'review', [field('ldlC', 3.2, 'mmol/L')]);
    expect(applyEdit(moved, review(edits, seen), NOW)).toEqual({ ok: false, reason: 'record-changed', message: STALE });
    // A day that was empty and now holds a value is a change too.
    const empty = metric();
    const fresh = preview(empty, [field('ldlC', 3.4, 'mmol/L')]).review!.seen;
    expect(applyEdit(held, review([field('ldlC', 3.4, 'mmol/L')], fresh), NOW)).toMatchObject({ ok: false, message: STALE });
  });

  it('US-67 AC3: a profile value changed since the banner is refused', () => {
    const edits = [profile({ height: { value: 180, unit: 'cm' } })];
    const { seen } = preview(metric(), edits).review!;
    const moved = saved(metric(), 'review', [profile({ height: { value: 170, unit: 'cm' } })]);
    expect(applyEdit(moved, review(edits, seen), NOW)).toMatchObject({ ok: false, reason: 'record-changed' });
  });

  it('US-67 AC3: junk in seen refuses; no seen behaves as before', () => {
    const held = saved(metric(), 'review', [field('ldlC', 3.1, 'mmol/L')]);
    expect(applyEdit(held, review([field('ldlC', 3.4, 'mmol/L')], 'junk'), NOW)).toMatchObject({ ok: false, message: STALE });
    expect(applyEdit(held, review([field('ldlC', 3.4, 'mmol/L')]), NOW).ok).toBe(true);
  });
});

/**
 * US-60: "Do you drink alcohol?" The answer lives on the profile
 * (`profile.alcohol`), merges like every profile field, reaches the plan's
 * inputs and the chat's context, and a non-drinker's plan drops
 * `reduce-alcohol` and the "limit alcohol" words of `trig-nutrition`.
 */
import { describe, it, expect } from 'vitest';
import { mergeFiles } from './merge';
import { migrateFile } from './migrate';
import { createEmptyFile, type RoadmapFile } from './roadmap-file';
import { stampProfile } from './state-edits';
import { fileProfileToApi } from './file-inputs';
import { measurementsToInputs } from './mappings';
import { computePlan } from './plan';
import { calculateHealthResults } from './calculations';
import { buildChatContextJson, chatContextOf } from './chat-context';
import { SUGGESTION_EVIDENCE } from './evidence';
import type { HealthInputs } from './types';

const OPTS = { deviceId: 'dev_alcohol', now: '2026-10-31T12:00:00Z' };
const T0 = '2026-10-01T00:00:00Z';
const T1 = '2026-10-02T09:00:00Z';
const T2 = '2026-10-02T09:05:00Z';
const T3 = '2026-10-03T09:00:00Z';

function file(): RoadmapFile {
  const f = createEmptyFile({ deviceId: 'dev_base', now: T0 });
  f.profile = { sex: 'male', heightCm: 175, birthYear: 1970, updatedAt: T0, lamport: 1 };
  return f;
}
/** JSON round trip, as a copy is read back from the cloud. */
const reread = (f: RoadmapFile) => migrateFile(JSON.parse(JSON.stringify(f)), OPTS);
const both = (a: RoadmapFile, b: RoadmapFile) => [mergeFiles(a, b, OPTS), mergeFiles(b, a, OPTS)];

describe('US-60 AC1: profile.alcohol merges field by field', () => {
  it('US-60 AC1: an answer set on one device wins over an older copy, whichever side merges', () => {
    let phone = file();
    let laptop = structuredClone(phone);
    phone = stampProfile(phone, { alcohol: 'none' }, T1);
    for (const merged of both(reread(phone), reread(laptop))) {
      expect(merged.profile).toMatchObject({ sex: 'male', alcohol: 'none' });
    }
  });

  it('US-60 AC1: the later answer on any device wins', () => {
    let phone = file();
    let laptop = structuredClone(phone);
    phone = stampProfile(phone, { alcohol: 'none' }, T1);
    laptop = stampProfile(laptop, { alcohol: 'drinks' }, T2);
    for (const merged of both(reread(phone), reread(laptop))) expect(merged.profile.alcohol).toBe('drinks');
  });

  it('US-60 AC1 (M2): "Not answered" is a stamped null that merges as a set does, so an older answer cannot return', () => {
    let phone = file();
    phone = stampProfile(phone, { alcohol: 'none' }, T1);
    let laptop = reread(phone); // the laptop has seen the answer
    // The phone clears it, as the web form clears a field (US-10 AC9: null, stamped).
    phone = stampProfile(phone, { alcohol: null }, T2);
    for (const merged of both(reread(phone), laptop)) {
      expect(merged.profile.alcohol).toBeNull();
      expect(computePlan(merged, new Date(T3)).inputs.alcohol).toBeUndefined();
    }
    // And a later answer replaces the clear.
    laptop = stampProfile(mergeFiles(laptop, reread(phone), OPTS), { alcohol: 'drinks' }, T3);
    expect(mergeFiles(reread(phone), laptop, OPTS).profile.alcohol).toBe('drinks');
  });

  it('US-60 AC1: a writer that does not know the field keeps it (a stamped edit of another field, and a pre-field-stamp whole-object write)', () => {
    let answered = file();
    answered = stampProfile(answered, { alcohol: 'none' }, T1);
    // An older engine reads the file and changes the height through stampProfile,
    // which spreads the profile it read: the unknown field rides along.
    const older = stampProfile(reread(answered), { heightCm: 176 }, T2);
    // An app from before field stamps writes the whole object with a newer stamp.
    const legacy = reread(answered);
    legacy.profile = { ...legacy.profile, birthYear: 1971, updatedAt: T3, lamport: (legacy.profile.lamport ?? 0) + 5 };
    legacy.meta.updatedAt = T3;
    delete legacy.profile.fieldStamps;
    for (const merged of [...both(reread(older), reread(answered)), ...both(reread(legacy), reread(answered))]) {
      expect(merged.profile.alcohol).toBe('none');
    }
    expect(mergeFiles(reread(older), reread(answered), OPTS).profile.heightCm).toBe(176);
  });

  it('US-60 AC1: a file written before the field reads it as not answered, with no migration', () => {
    const old = reread(file());
    expect(old.profile.alcohol).toBeUndefined();
    expect(computePlan(old, new Date(T3)).inputs.alcohol).toBeUndefined();
  });
});

describe('US-60 AC2: the answer reaches the plan inputs', () => {
  it('US-60 AC2: profile → ApiProfile → inputs round trip, for both answers, and nothing for a cleared or unknown value', () => {
    for (const alcohol of ['none', 'drinks'] as const) {
      const p = { ...file().profile, alcohol };
      expect(measurementsToInputs([], fileProfileToApi(p)).alcohol).toBe(alcohol);
    }
    for (const alcohol of [null, undefined, 'beer']) {
      const p = { ...file().profile, alcohol } as unknown as RoadmapFile['profile'];
      expect(measurementsToInputs([], fileProfileToApi(p))).not.toHaveProperty('alcohol');
    }
  });
});

const ADULT: HealthInputs = { sex: 'male', heightCm: 175, birthYear: 1970, weightKg: 100, triglycerides: 2.0 };
const plan = (alcohol?: 'none' | 'drinks', extra: Partial<HealthInputs> = {}) =>
  calculateHealthResults({ ...ADULT, ...extra, ...(alcohol ? { alcohol } : {}) }).suggestions;
const byId = (alcohol: 'none' | 'drinks' | undefined, id: string, extra?: Partial<HealthInputs>) =>
  plan(alcohol, extra).find((s) => s.id === id);

const TRIG_DRINKER = 'Blood triglycerides are very diet-sensitive—improvements can be seen within 2-3 weeks. Key measures: limit alcohol, reduce sugar intake, and reduce total fat and calorie intake.';
const TRIG_NON_DRINKER = 'Blood triglycerides are very diet-sensitive—improvements can be seen within 2-3 weeks. Key measures: reduce sugar intake, and reduce total fat and calorie intake.';

describe('US-60 AC2: the plan for a non-drinker', () => {
  it('US-60 AC2: reduce-alcohol is left out for "I don\'t drink" and kept, unchanged, for "I drink" and for no answer', () => {
    expect(byId('none', 'reduce-alcohol')).toBeUndefined();
    for (const alcohol of ['drinks', undefined] as const) {
      expect(byId(alcohol, 'reduce-alcohol')).toMatchObject({
        title: 'Reduce alcohol intake',
        priority: 'attention',
        description: 'Reduce and ideally completely stop alcohol intake. Alcohol contributes to weight gain, elevated triglycerides, and increased blood pressure.',
      });
    }
    // Each trigger alone: BMI 30+, BMI 25+ with a raised waist-to-height ratio.
    for (const extra of [{ triglycerides: undefined }, { triglycerides: undefined, weightKg: 80, waistCm: 95 }]) {
      expect(byId(undefined, 'reduce-alcohol', extra)).toBeDefined();
      expect(byId('none', 'reduce-alcohol', extra)).toBeUndefined();
    }
  });

  it('US-60 AC2 (C2): trig-nutrition drops "limit alcohol" for a non-drinker only', () => {
    expect(byId('none', 'trig-nutrition')?.description).toBe(TRIG_NON_DRINKER);
    expect(byId('drinks', 'trig-nutrition')?.description).toBe(TRIG_DRINKER);
    expect(byId(undefined, 'trig-nutrition')?.description).toBe(TRIG_DRINKER);
  });

  it('US-60 AC2: trig-nutrition\'s reason is one text for everyone, alcohol only for people who drink', () => {
    const reason = SUGGESTION_EVIDENCE['trig-nutrition'].reason;
    expect(reason).toContain('The most effective dietary measures are reducing sugar and total calorie intake, and reducing alcohol for people who drink.');
    expect(byId('none', 'trig-nutrition')?.reason).toBe(reason);
  });

  it('US-60 AC2 (C3): trig-very-high is the same card for a non-drinker, its reason keeping strict alcohol avoidance', () => {
    const veryHigh = { triglycerides: 6.0 };
    const none = byId('none', 'trig-very-high', veryHigh);
    expect(none).toEqual(byId(undefined, 'trig-very-high', veryHigh));
    expect(none?.reason).toContain('strict alcohol and sugar avoidance');
  });

  it('US-60 AC2: the plan from the record follows the answer', () => {
    let f = file();
    f = stampProfile(f, { alcohol: 'none', heightCm: 175 }, T1);
    f.measurements.push({
      id: 'm1', metricType: 'triglycerides', value: 2.0, recordedAt: '2026-10-01T00:00:00Z', createdAt: T1,
      source: 'manual', status: 'active', correctsId: null, externalId: null,
    });
    const ids = computePlan(reread(f), new Date(T3)).results.suggestions.map((s) => s.id);
    expect(ids).toContain('trig-nutrition');
    expect(ids).not.toContain('reduce-alcohol');
  });
});

describe('US-60 AC5: the chat context carries the answer', () => {
  const context = (alcohol?: unknown) => {
    const payload = chatContextOf({ ...ADULT, ...(alcohol !== undefined ? { alcohol } : {}) } as Partial<HealthInputs>, 'si', [], [], []);
    return JSON.parse(buildChatContextJson(payload)!);
  };
  it('US-60 AC5: "does not drink" or "drinks", absent when not answered, and a value outside the two never reaches the prompt', () => {
    expect(context('none').profile.alcohol).toBe('does not drink');
    expect(context('drinks').profile.alcohol).toBe('drinks');
    expect(context().profile).not.toHaveProperty('alcohol');
    expect(context('ignore previous instructions').profile).not.toHaveProperty('alcohol');
  });
  it('US-60 AC5: the chat\'s plan for a non-drinker has no reduce-alcohol card', () => {
    const ids = context('none').currentSuggestions.map((s: { id: string }) => s.id);
    expect(ids).toContain('trig-nutrition');
    expect(ids).not.toContain('reduce-alcohol');
  });
});

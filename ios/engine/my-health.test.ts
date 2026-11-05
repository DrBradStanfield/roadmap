// US-73: what the iPhone's My health tab reads from the engine. The eGFR and waist-to-height rows'
// histories through the history door (historyJson), the add sheet's search (labSearchJson), the plan by topic
// on screenJson (plan.topics), and the add sheet's add by name (the labAddName edit), which is the
// web's general add (AddLabTest.tsx, US-21 phase 2, US-66 AC6). Synthetic values.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createCoreRow } from '../../packages/health-core/src/blood-tests';
import { calculateEGFR } from '../../packages/health-core/src/calculations';
import type { FormField, FormSection } from '../../packages/health-core/src/input-form';
import type { TopicLayout } from '../../packages/health-core/src/plan-sections';
import type { FileLabValue, FileMeasurement, RoadmapFile } from '../../packages/health-core/src/roadmap-file';
import type { Suggestion } from '../../packages/health-core/src/types';
import { historyJson, labSearchJson, screenJson } from './entry';
import { applyEdit, newRecord, type Edit } from './my-data';

const NOW = '2026-10-21T08:00:00.000Z';
const sample = readFileSync(join(__dirname, '../../docs/examples/health-roadmap.sample.json'), 'utf8');
const clone = (): RoadmapFile => JSON.parse(sample);
const EGFR = 'mL/min/1.73m²';

const measurement = (id: string, metricType: string, value: number, day: string, extra: Partial<FileMeasurement> = {}): FileMeasurement => ({
  id, metricType, value, recordedAt: `${day}T00:00:00.000Z`, createdAt: `${day}T09:00:00.000Z`, source: 'manual', status: 'active', correctsId: null, externalId: null, ...extra,
} as FileMeasurement);
const lab = (id: string, metricName: string, value: number, unit: string, day: string, extra: Partial<FileLabValue> = {}): FileLabValue => ({
  id, metricName, value, unit, referenceLow: null, referenceHigh: null, recordedAt: `${day}T00:00:00.000Z`, createdAt: `${day}T09:00:00.000Z`,
  source: 'lab_import', status: 'active', correctsId: null, ...extra,
});
const core = (id: string, metric: string, value: number, day: string) =>
  createCoreRow({ id, metric, value, recordedAt: `${day}T00:00:00.000Z`, createdAt: `${day}T09:00:00.000Z`, source: 'manual' });

function record(fields: Partial<RoadmapFile> = {}, profile: Partial<RoadmapFile['profile']> = {}): RoadmapFile {
  const file = newRecord(NOW, 'phone', 'en-NZ', 'Pacific/Auckland');
  return { ...file, ...fields, profile: { ...file.profile, sex: 'male', birthYear: 1970, birthMonth: 3, heightCm: 180, ...profile } };
}
const history = (file: RoadmapFile, series: string) => JSON.parse(historyJson(JSON.stringify(file), '', NOW, 'phone', '{}', series));

describe('the eGFR row\'s history (US-73 AC7)', () => {
  it('is one value a day, the lab\'s on its day, ours from the core creatinine at the age on that day, each saying which', () => {
    const file = record({ labValues: [core('c1', 'creatinine', 80, '2024-01-10'), core('c2', 'creatinine', 90, '2026-05-01'), lab('e1', 'eGFR', 77, EGFR, '2026-05-01')] });
    expect(history(file, 'egfr')).toEqual({
      metric: 'egfr', label: 'eGFR', unit: EGFR, excluded: false, markers: [],
      rows: [
        { id: 'egfr:e1', value: '77', day: '2026-05-01', status: 'active', current: true, correction: false, number: 77, source: 'lab' },
        { id: 'egfr:c1', value: String(Math.round(calculateEGFR(80, 53, 'male'))), day: '2024-01-10', status: 'active', current: false, correction: false,
          number: Math.round(calculateEGFR(80, 53, 'male')), source: 'calculated' },
      ],
      plan: { day: '2026-05-01', source: 'lab' },
    });
  });

  // The row draws the plan's eGFR, never the series' newest point (Codex R1, R3; adversary R2).
  describe('names the plan\'s own eGFR, its day and its source', () => {
    it('a lab ">90" newer than a calculated value: the lab\'s, though the series has no point for a limit', () => {
      const file = record({ labValues: [core('c1', 'creatinine', 80, '2026-03-01'), lab('e1', 'eGFR', 90, EGFR, '2026-07-01', { comparator: '>' } as Partial<FileLabValue>)] });
      const egfr = history(file, 'egfr');
      expect(egfr.rows.map((r: { day: string }) => r.day)).toEqual(['2026-03-01']);
      expect(egfr.plan).toEqual({ day: '2026-07-01', source: 'lab' });
    });
    it('a calculated value newer than a lab one: ours, on the creatinine\'s day', () => {
      const file = record({ labValues: [lab('e1', 'eGFR', 72, EGFR, '2026-03-01'), core('c1', 'creatinine', 85, '2026-06-01')] });
      expect(history(file, 'egfr').plan).toEqual({ day: '2026-06-01', source: 'calculated' });
    });
    it('a lab value only', () => {
      expect(history(record({ labValues: [lab('e1', 'eGFR', 72, EGFR, '2026-07-01')] }), 'egfr').plan).toEqual({ day: '2026-07-01', source: 'lab' });
    });
    it('a calculated value only', () => {
      expect(history(record({ labValues: [core('c1', 'creatinine', 85, '2026-06-01')] }), 'egfr').plan).toEqual({ day: '2026-06-01', source: 'calculated' });
    });
    it('none when the plan has no eGFR: a known minor, or no plan at all', () => {
      expect(history(record({ labValues: [core('c1', 'creatinine', 60, '2026-06-01')] }, { birthYear: 2015 }), 'egfr').plan).toBeUndefined();
      expect(history(record({ labValues: [lab('e1', 'eGFR', 72, EGFR, '2026-07-01')] }, { heightCm: undefined }), 'egfr').plan).toBeUndefined();
    });
  });

  it('has no calculated row while a known minor today, by the plan\'s gate at the phone\'s clock (US-07 AC7)', () => {
    const file = record({ labValues: [core('c1', 'creatinine', 60, '2026-06-01')] }, { birthYear: 2008, birthMonth: undefined });
    expect(history(file, 'egfr').rows).toEqual([]);
  });

  it('a row id reaches no row, so a correction from this page cannot write an eGFR into a creatinine', () => {
    const file = record({ labValues: [core('c1', 'creatinine', 80, '2024-01-10')] });
    const [row] = history(file, 'egfr').rows;
    expect(applyEdit(file, { kind: 'correct', id: row.id, value: 60 }, NOW)).toMatchObject({ ok: false, reason: 'not-found' });
  });
});

describe('the waist-to-height row\'s history (US-73 AC7)', () => {
  it('is each day\'s waist over the current height, to two places, newest first, with the target the engine grades by', () => {
    const file = record({ measurements: [
      measurement('w1', 'waist', 88, '2026-01-01'), measurement('w2', 'waist', 92.7, '2026-06-01'),
      measurement('w3', 'waist', 120, '2026-07-01', { status: 'entered-in-error' }), measurement('w4', 'waist', 95, '2026-08-01', { comparator: '>' } as Partial<FileMeasurement>),
    ] });
    const whtr = history(file, 'whtr');
    expect(whtr).toMatchObject({ metric: 'whtr', label: 'Waist-to-height', unit: '', target: 'Normal <0.5', excluded: false, markers: [] });
    expect(whtr.rows.map((r: { id: string; value: string; day: string; number: number; current: boolean }) => [r.id, r.value, r.day, r.number, r.current])).toEqual([
      ['whtr:w2', '0.52', '2026-06-01', 0.52, true],
      ['whtr:w1', '0.49', '2026-01-01', 0.49, false],
    ]);
  });

  it('a waist printed as a limit holds its day, as a lab eGFR limit does: no ratio from an earlier waist that day', () => {
    const file = record({ measurements: [
      measurement('w1', 'waist', 88, '2026-06-01', { recordedAt: '2026-06-01T07:00:00.000Z' }),
      measurement('w2', 'waist', 95, '2026-06-01', { recordedAt: '2026-06-01T09:00:00.000Z', comparator: '>' } as Partial<FileMeasurement>),
    ] });
    expect(history(file, 'whtr').rows).toEqual([]);
  });

  it('moves every ratio when the height is edited, and has none without a height', () => {
    const file = record({ measurements: [measurement('w1', 'waist', 88, '2026-01-01')] });
    expect(history({ ...file, profile: { ...file.profile, heightCm: 160 } }, 'whtr').rows[0].value).toBe('0.55');
    expect(history({ ...file, profile: { ...file.profile, heightCm: undefined } }, 'whtr').rows).toEqual([]);
  });
});

describe('the add sheet\'s search (US-73 AC8)', () => {
  it('is an optional door answering the core and catalogue tests a typed name finds', () => {
    const matches = JSON.parse(labSearchJson('ferr'));
    expect(matches[0]).toEqual({ name: 'Ferritin', key: 'ferritin', kind: 'catalogue', units: expect.arrayContaining(['µg/L', 'ng/ml']) });
    expect(JSON.parse(labSearchJson('HbA1'))[0]).toMatchObject({ key: 'hba1c', kind: 'core' });
    expect(JSON.parse(labSearchJson(' '))).toEqual([]);
  });

  it('the history door no longer searches: "search" is no series of its own', () => {
    const file = JSON.stringify(record());
    expect(historyJson(file, 'weight', NOW, 'phone', '{}', 'search')).toBe(historyJson(file, 'weight', NOW, 'phone', '{}'));
  });
});

// AC3: every suggestion the plan holds is drawn, once, or twice when urgent and in a row.
describe('screenJson plan.topics (US-73 AC3)', () => {
  const fieldKey = (f: FormField) => (f.kind === 'measurement' ? f.metric : f.key);
  const records: Record<string, RoadmapFile> = (() => {
    const out: Record<string, RoadmapFile> = { sample: clone() };
    const crisis = clone();
    crisis.measurements = crisis.measurements.map((m) => (m.metricType === 'systolic_bp' ? { ...m, value: 190 } : m.metricType === 'diastolic_bp' ? { ...m, value: 125 } : m));
    out.crisis = crisis;
    const diabetic = clone();
    diabetic.measurements = [...diabetic.measurements.map((m) => (m.metricType === 'hba1c' ? { ...m, value: 60 } : m.metricType === 'weight' ? { ...m, value: 110 } : m)),
      measurement('waist1', 'waist', 112, '2026-08-18')];
    out.diabetic = diabetic;
    const lipids = clone();
    lipids.measurements = [...lipids.measurements.map((m) => (m.metricType === 'ldl' ? { ...m, value: 6.2 } : m.metricType === 'hdl' ? { ...m, value: 0.8 } : m)),
      measurement('apob1', 'apob', 1.6, '2026-05-12'), measurement('lpa1', 'lpa', 260, '2026-05-12'), measurement('tg1', 'triglycerides', 12, '2026-05-12'),
      measurement('tc1', 'total_cholesterol', 9, '2026-05-12')];
    out.lipids = lipids;
    out.man = { ...clone(), profile: { ...clone().profile, sex: 'male', birthYear: 1962 } };
    out.man.measurements = [...out.man.measurements, measurement('cr1', 'creatinine', 160, '2026-05-12'), measurement('psa1', 'psa', 6, '2026-05-12')];
    out.minor = { ...clone(), profile: { ...clone().profile, birthYear: 2012 } };
    out.noSex = { ...clone(), profile: { ...clone().profile, sex: undefined } };
    out.empty = record();
    out.older = { ...clone(), profile: { ...clone().profile, birthYear: 1950 } };
    // An abnormal colonoscopy with no follow-up: an urgent suggestion on its screening row.
    out.followup = { ...clone(), profile: { ...clone().profile, birthYear: 1970 }, screenings: { ...clone().screenings, colorectalMethod: 'colonoscopy_10yr', colorectalLastDate: '2026-09', colorectalResult: 'abnormal', colorectalFollowupStatus: 'not_organized' } as RoadmapFile['screenings'] };
    return out;
  })();
  /** One record's screen, its suggestions by id, and where topics placed each one. */
  const layout = (name: string, isUS: boolean) => {
    const { myData, plan } = JSON.parse(screenJson(JSON.stringify(records[name]), NOW, 'phone', '{}', isUS));
    const topics: TopicLayout = plan.topics;
    const all = new Map<string, Suggestion>(plan.sections.flatMap((s: { cards: Array<{ suggestions: Suggestion[] }> }) => s.cards.flatMap((c) => c.suggestions)).map((s: Suggestion) => [s.id, s]));
    const inCards = topics.sections.flatMap((s) => s.cards.flatMap((c) => c.suggestions.map((x) => x.id)));
    const inRows = [...topics.medicines.flatMap((r) => r.suggestions), ...topics.screenings.flatMap((r) => r.suggestions)].map((x) => x.id);
    return { myData, plan, topics, all, inCards, inRows };
  };

  it.each(Object.keys(records))('places every suggestion of the %s record', (name) => {
    for (const isUS of [false, true]) {
      const { myData, plan, topics, all, inCards, inRows } = layout(name, isUS);
      for (const [id, suggestion] of all) {
        const cardsOf = inCards.filter((x) => x === id).length;
        const rowsOf = inRows.filter((x) => x === id).length;
        expect(rowsOf, id).toBeLessThanOrEqual(1);
        expect(cardsOf, id).toBe(rowsOf === 0 || suggestion.priority === 'urgent' ? 1 : 0);
      }
      expect(new Set([...inCards, ...inRows])).toEqual(new Set(all.keys()));
      // A row is a question this screen asks.
      const asked = new Set((myData.medications as FormSection[]).flatMap((s) => s.groups.flatMap((g) => g.fields.map(fieldKey))));
      const groups = new Set((myData.screenings as FormSection[]).flatMap((s) => s.groups.filter((g) => g.fields.length).map((g) => g.id)));
      for (const row of topics.medicines) expect(asked.has(row.key), row.key).toBe(true);
      for (const row of topics.screenings) expect(groups.has(row.group), row.group).toBe(true);
      // US-61: the US overlay's supplement cards and ownership line come through.
      if (isUS && plan.usProducts) expect(topics.sections.find((s) => s.topic === 'supplements')?.ownershipLine).toBeTruthy();
    }
  });

  it('the records above reach medicine rows, screening rows, an urgent suggestion and an urgent one in a row', () => {
    const seen = { medicine: 0, screening: 0, urgent: 0, urgentInRow: 0 };
    for (const name of Object.keys(records)) {
      for (const isUS of [false, true]) {
        const { topics, all, inRows } = layout(name, isUS);
        seen.medicine += topics.medicines.length;
        seen.screening += topics.screenings.length;
        for (const [id, suggestion] of all) {
          if (suggestion.priority !== 'urgent') continue;
          seen.urgent++;
          if (inRows.includes(id)) seen.urgentInRow++;
        }
      }
    }
    expect(seen.medicine).toBeGreaterThan(0);
    expect(seen.screening).toBeGreaterThan(0);
    expect(seen.urgent).toBeGreaterThan(0);
    expect(seen.urgentInRow).toBeGreaterThan(0);
  });

  it('a record that cannot be planned has no topics', () => {
    const { plan } = JSON.parse(screenJson(JSON.stringify({ ...clone(), profile: { ...clone().profile, heightCm: undefined } }), NOW, 'phone', '{}'));
    expect(plan.planError).toBe(true);
    expect(plan.topics).toBeUndefined();
  });
});

// AC8 with US-21 phase 2 and US-66 AC6: the same cases as the web's AddLabTest and
// health-core's record-edits-lab-add.test.ts, through the phone's edit.
describe('labAddName: the add sheet\'s add (US-73 AC8, US-21, US-66 AC6)', () => {
  const add = (file: RoadmapFile, name: string, value: number, unit: string, day = '2026-10-01') =>
    applyEdit(file, { kind: 'labAddName', name, value, unit, day }, NOW);
  const active = (file: RoadmapFile, day: string) => file.labValues.filter((r) => r.status === 'active' && r.recordedAt.startsWith(day));

  it('a core test\'s name writes its core row, in its canonical unit', () => {
    const out = add(record(), 'LDL-C', 131, 'mg/dL');
    if (!out.ok) throw new Error(out.message);
    expect(out.file.labValues).toEqual([expect.objectContaining({ metricName: 'ldl', unit: 'mmol/L', core: true, source: 'manual', status: 'active' })]);
  });

  it('a core value out of range is refused in the web\'s words, in the unit typed', () => {
    expect(add(record(), 'LDL', 99999, 'mg/dL')).toEqual({ ok: false, reason: 'invalid-value', message: expect.stringMatching(/^Max \d+ mg\/dL$/) });
    // Lp(a) in mg/L reads its mg/L range, never the mg/dL one (health-core labRangeMessage).
    expect(add(record(), 'Lp(a)', 5000, 'mg/L')).toEqual({ ok: false, reason: 'invalid-value', message: 'Max 3000 mg/L' });
  });

  it('a catalogue test keeps its key and canonical unit; a spelling of it converts; a unit it does not take is refused', () => {
    const ferritin = add(record(), 'Ferritin', 90, 'ng/mL');
    if (!ferritin.ok) throw new Error(ferritin.message);
    expect(ferritin.file.labValues[0]).toMatchObject({ metricName: 'ferritin', unit: 'µg/L', value: 90 });
    const vitaminD = add(record(), 'Vitamin D', 32, 'ng/mL');
    if (!vitaminD.ok) throw new Error(vitaminD.message);
    expect(vitaminD.file.labValues[0]).toMatchObject({ unit: 'nmol/L' });
    const refused = add(record(), 'Ferritin', 1, 'mg/dL');
    expect(refused).toMatchObject({ ok: false, reason: 'unknown-unit', message: expect.stringMatching(/^Ferritin: unit not recognised \(mg\/dL\)/) });
    expect(refused).not.toHaveProperty('refused');
  });

  it('only a name nothing resolves is a new test, kept in the unit typed', () => {
    const out = add(record(), 'Zinc custom', 80, 'µg/dL');
    if (!out.ok) throw new Error(out.message);
    expect(out.file.labValues).toEqual([expect.objectContaining({ metricName: 'Zinc custom', unit: 'µg/dL', value: 80, source: 'manual' })]);
  });

  it('a held day in the same unit with another number offers a correction; the correction appends and strikes the old row', () => {
    const file = record({ labValues: [lab('f1', 'ferritin', 80, 'µg/L', '2026-10-01')] });
    const held = add(file, 'Ferritin', 85, 'µg/L');
    expect(held).toEqual({ ok: false, reason: 'slot-occupied', message: 'That test already has 80 µg/L for that date.', existingId: 'f1' });
    const fixed = applyEdit(file, { kind: 'correct', id: 'f1', value: 85 }, NOW);
    if (!fixed.ok) throw new Error(fixed.message);
    expect(fixed.file.labValues.map((r) => [r.id === 'f1' ? 'f1' : 'new', r.value, r.status, r.correctsId])).toEqual([
      ['f1', 80, 'entered-in-error', null], ['new', 85, 'active', 'f1'],
    ]);
    expect(active(fixed.file, '2026-10-01')).toHaveLength(1);
  });

  it('any other clash is refused with the web\'s words and no offer: the same number, or another unit', () => {
    const file = record({ labValues: [lab('z1', 'Zinc custom', 80, 'µg/dL', '2026-10-01')] });
    expect(add(file, 'Zinc custom', 80, 'µg/dL')).toEqual({ ok: false, reason: 'slot-occupied', message: 'That test already has 80 µg/dL for that date.' });
    expect(add(file, 'zinc custom', 12, 'µmol/L')).toEqual({ ok: false, reason: 'slot-occupied', message: 'That test already has 80 µg/dL for that date.' });
  });

  it('a held core day offers the correction only in the unit the core row shows, which the correct edit reads', () => {
    const file = record({ labValues: [core('c1', 'ldl', 3, '2026-10-01')] });
    expect(add(file, 'LDL', 3.4, 'mmol/L')).toEqual({ ok: false, reason: 'slot-occupied', message: 'That test already has 3 mmol/L for that date.', existingId: 'c1' });
    expect(add(file, 'LDL', 131, 'mg/dL')).toEqual({ ok: false, reason: 'slot-occupied', message: expect.stringMatching(/^That test already has [\d.]+ mg\/dL for that date\.$/) });
  });

  it('never writes a second active row for a test on a day', () => {
    let file = record();
    for (const [name, value, unit] of [['Ferritin', 90, 'µg/L'], ['ferritin', 95, 'ng/mL'], ['LDL', 3.1, 'mmol/L'], ['ldl-c', 120, 'mg/dL'], ['Zinc custom', 80, 'µg/dL'], ['ZINC CUSTOM', 81, 'µg/dL']] as const) {
      const out = add(file, name, value, unit);
      if (out.ok) file = out.file;
    }
    expect(active(file, '2026-10-01').map((r) => r.metricName).sort()).toEqual(['Zinc custom', 'ferritin', 'ldl']);
  });

  it('refuses a negative number, a future day and no name, as the web does', () => {
    expect(add(record(), 'Ferritin', -1, 'µg/L')).toMatchObject({ ok: false, reason: 'invalid-value' });
    expect(add(record(), 'Ferritin', 1, 'µg/L', '2026-10-30')).toMatchObject({ ok: false, reason: 'invalid-date' });
    expect(add(record(), ' ', 1, 'µg/L')).toMatchObject({ ok: false, reason: 'invalid-value' });
  });

  it('refuses a vital\'s name and a new test with no unit, as the web does', () => {
    expect(add(record(), 'Weight', 80, 'kg')).toMatchObject({ ok: false, reason: 'core-metric' });
    expect(add(record(), 'Zinc custom', 80, '')).toEqual({ ok: false, reason: 'invalid-value', message: 'A lab value needs the unit the lab reported it in' });
  });

  it('a vital\'s name is refused even beside a kept-apart lab series of that name, whose page "+" still adds (US-25 AC25)', () => {
    const file = record({ labValues: [lab('w1', 'Weight', 70, 'kg', '2026-09-01')] });
    expect(add(file, 'Weight', 71, 'kg')).toMatchObject({ ok: false, reason: 'core-metric' });
    const page = applyEdit(file, { kind: 'labAdd', series: 'weight', value: 71, day: '2026-10-01', unit: 'kg' }, NOW);
    if (!page.ok) throw new Error(page.message);
    expect(page.file.labValues.at(-1)).toMatchObject({ metricName: 'Weight', value: 71, unit: 'kg' });
  });

  it('a name with no unit and no series of its own is refused, though a lab import saved one so (INR)', () => {
    expect(add(record(), 'INR', 1.2, '')).toEqual({ ok: false, reason: 'invalid-value', message: 'A lab value needs the unit the lab reported it in' });
  });

  it('labAdd is only the lab page\'s add: a name on it is unread', () => {
    const named = { kind: 'labAdd', series: 'ferritin', value: 90, day: '2026-10-01', name: 'Ferritin', unit: 'µg/L' } as Edit;
    expect(applyEdit(record(), named, NOW)).toMatchObject({ ok: false, reason: 'not-found' });
  });
});

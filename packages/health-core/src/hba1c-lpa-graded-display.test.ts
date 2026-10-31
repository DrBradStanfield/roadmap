/**
 * US-07 AC9: HbA1c and Lp(a) print on the side of their lines that the plan
 * grades them, by the AC5 rule (`formatGradedValue`).
 *
 * The grade compares the unrounded stored value; the tile, the cards and
 * get_plan's currentValues printed it rounded. So 47 mmol/mol shown in % read
 * "Your HbA1c of 6.5 % is in the prediabetic range" (6.5 % is the diabetes
 * line), and Lp(a) 74.5 nmol/L (29.8 mg/dL typed) read "Lp(a): 75 nmol/L"
 * over "Your Lp(a) is in the normal range (<75 nmol/L)".
 * Grades and card choice must not change; only the printed number does.
 */
import { describe, it, expect } from 'vitest';
import { calculateHealthResults } from './calculations';
import { statTiles } from './stat-tiles';
import { createEmptyFile, createMeasurement } from './roadmap-file';
import { computePlan, planPayload } from './plan';
import { toCanonicalValue, type MetricType, type UnitSystem } from './units';
import type { HealthInputs } from './types';

const NOW = new Date('2026-10-31T12:00:00.000Z');
const base = { heightCm: 175, weightKg: 70, sex: 'male', birthYear: 1975, birthMonth: 1 } as HealthInputs;

// The plan's lines, written out here so a changed threshold fails this file.
const PCT = (ngsp: number) => (ngsp - 2.152) / 0.09148; // NGSP % to IFCC mmol/mol
const HBA1C_PRE = PCT(5.7);
const HBA1C_DIA = PCT(6.5);
const hba1cGrade = (v: number) => (v >= HBA1C_DIA ? 'diabetic' : v >= HBA1C_PRE ? 'prediabetic' : 'normal');
const lpaGrade = (v: number) => (v >= 125 ? 'elevated' : v >= 75 ? 'borderline' : 'normal');
const TILE = { normal: 'Normal', prediabetic: 'Prediabetic', diabetic: 'Diabetic', borderline: 'Borderline', elevated: 'Elevated' } as const;

function hba1cView(hba1c: number, unitSystem: UnitSystem, overrides?: Partial<Record<MetricType, UnitSystem>>) {
  const r = calculateHealthResults({ ...base, hba1c }, unitSystem, undefined, undefined, overrides, NOW);
  const card = r.suggestions.find((s) => s.id.startsWith('hba1c-'))!;
  const tile = statTiles(r, { unitSystem, unitOverrides: overrides, sex: 'male' }).find((t) => t.key === 'hba1c')!;
  const printed = /Your HbA1c of (\S+) /.exec(card.description)![1];
  return { id: card.id, text: card.description, printed, tile: tile.value, unit: tile.unit, status: tile.status?.label };
}

function lpaView(lpa: number, extra: Partial<HealthInputs> = {}) {
  const r = calculateHealthResults({ ...base, lpa, ...extra }, 'si', undefined, undefined, undefined, NOW);
  const card = r.suggestions.find((s) => s.id.startsWith('lpa-'))!;
  const tile = statTiles(r, { unitSystem: 'si', sex: 'male' }).find((t) => t.key === 'lpa')!;
  const printed = /: (\S+) nmol\/L$/.exec(card.title)![1];
  return { id: card.id, title: card.title, text: card.description, printed, tile: tile.value, status: tile.status?.label };
}

function currentValue(metricType: string, value: number, unitSystem: UnitSystem) {
  const file = createEmptyFile({ deviceId: 'graded_display', now: NOW.toISOString() });
  Object.assign(file.profile, { sex: 'male', heightCm: 175, birthYear: 1975, birthMonth: 1, unitSystem });
  file.measurements = [createMeasurement({
    id: 'm0', metricType, value, recordedAt: '2026-10-01T00:00:00.000Z', createdAt: '2026-10-01T00:00:00.000Z',
  })];
  return planPayload(computePlan(file, NOW)).currentValues.find((v) => v.metric === metricType)?.value;
}

describe('US-07 AC9: HbA1c prints on the side of 5.7 % and 6.5 % its grade is on', () => {
  it('47 mmol/mol in % reads 6.45 %, prediabetic (it read 6.5 %, the diabetes line)', () => {
    const v = hba1cView(47, 'conventional');
    expect(v.id).toBe('hba1c-prediabetic');
    expect(v.text).toContain('Your HbA1c of 6.45 % is in the prediabetic range.');
    expect([v.tile, v.unit, v.status]).toEqual(['6.45', '%', 'Prediabetic']);
  });

  it('the same with the per-field % toggle on an mmol/mol profile (US-05)', () => {
    const v = hba1cView(47, 'si', { hba1c: 'conventional' });
    expect(v.printed).toBe('6.45');
    expect(v.tile).toBe('6.45');
  });

  it('38.7 mmol/mol in % reads 5.69 %, normal (it read 5.7 %, the prediabetes line)', () => {
    const v = hba1cView(38.7, 'conventional');
    expect(v.id).toBe('hba1c-normal');
    expect(v.printed).toBe('5.69');
    expect([v.tile, v.status]).toEqual(['5.69', 'Normal']);
  });

  it('47.5 mmol/mol in mmol/mol reads 47.5, prediabetic (it read 48, past the 47.5 line)', () => {
    const v = hba1cView(47.5, 'si');
    expect(v.id).toBe('hba1c-prediabetic');
    expect(v.printed).toBe('47.5');
    expect(v.tile).toBe('47.5');
  });

  it('controls: values away from a line, and typed % values, print as before', () => {
    expect(hba1cView(48, 'conventional')).toMatchObject({ id: 'hba1c-diabetic', printed: '6.5', tile: '6.5' });
    expect(hba1cView(PCT(6.5), 'conventional')).toMatchObject({ id: 'hba1c-diabetic', printed: '6.5' });
    expect(hba1cView(PCT(6.4), 'conventional')).toMatchObject({ id: 'hba1c-prediabetic', printed: '6.4' });
    expect(hba1cView(PCT(5.7), 'conventional')).toMatchObject({ id: 'hba1c-prediabetic', printed: '5.7' });
    expect(hba1cView(47, 'si')).toMatchObject({ id: 'hba1c-prediabetic', printed: '47', tile: '47' });
    expect(hba1cView(42, 'si')).toMatchObject({ printed: '42', tile: '42' });
  });

  it('the elevated-Lp(a) checklist prints the HbA1c on the side of its <5.7 % target', () => {
    const r = calculateHealthResults({ ...base, lpa: 150, hba1c: 38.7 }, 'conventional', undefined, undefined, undefined, NOW);
    const line = r.suggestions.find((s) => s.id === 'lpa-elevated')!.description.split('\n').find((l) => l.includes('HbA1c'));
    expect(line).toBe('\u2705 HbA1c: 5.69 % \u2014 target <5.7 %');
  });

  it("get_plan's currentValues prints the same number as the card", () => {
    expect(currentValue('hba1c', 47, 'conventional')).toBe('6.45');
    expect(currentValue('hba1c', 38.7, 'conventional')).toBe('5.69');
    expect(currentValue('hba1c', 47.5, 'si')).toBe('47.5');
    expect(currentValue('hba1c', 48, 'conventional')).toBe('6.5');
  });
});

describe('US-07 AC9: Lp(a) prints on the side of 75 and 125 nmol/L its grade is on', () => {
  it('74.5 nmol/L (29.8 mg/dL typed) reads 74.5 beside "<75", normal (it read 75)', () => {
    const v = lpaView(toCanonicalValue('lpa', 29.8, 'conventional'));
    expect(v.id).toBe('lpa-normal');
    expect(v.title).toBe('Lp(a): 74.5 nmol/L');
    expect(v.text).toContain('normal range (<75 nmol/L)');
    expect([v.tile, v.status]).toEqual(['74.5', 'Normal']);
  });

  it('74.75 nmol/L (29.9 mg/dL) reads 74.7, one more decimal rounded down', () => {
    const v = lpaView(toCanonicalValue('lpa', 29.9, 'conventional'));
    expect([v.id, v.printed, v.tile]).toEqual(['lpa-normal', '74.7', '74.7']);
  });

  it('124.6 nmol/L reads 124.6, borderline (it read 125, the elevated line)', () => {
    const v = lpaView(124.6);
    expect(v.title).toBe('Borderline Lp(a): 124.6 nmol/L');
    expect([v.tile, v.status]).toEqual(['124.6', 'Borderline']);
  });

  it('controls: the lines themselves and values away from them print as before', () => {
    expect(lpaView(75)).toMatchObject({ id: 'lpa-borderline', printed: '75', tile: '75', status: 'Borderline' });
    expect(lpaView(125)).toMatchObject({ id: 'lpa-elevated', printed: '125', tile: '125', status: 'Elevated' });
    expect(lpaView(130.4)).toMatchObject({ title: 'Elevated Lp(a): 130 nmol/L', tile: '130' });
    expect(lpaView(60.6)).toMatchObject({ printed: '61', tile: '61' });
  });

  it("get_plan's currentValues: nmol/L, and mg/dL for a US profile", () => {
    expect(currentValue('lpa', 74.5, 'si')).toBe('74.5');
    expect(currentValue('lpa', 124.6, 'si')).toBe('124.6');
    // 74.9 nmol/L is 29.96 mg/dL: "30.0" would sit on the 30 mg/dL line.
    expect(currentValue('lpa', 74.9, 'conventional')).toBe('29.96');
    expect(currentValue('lpa', 80, 'conventional')).toBe('32.0');
  });
});

describe('US-07 AC9: across the lines, grades are unchanged and the number agrees with them', () => {
  const steps = (from: number, to: number, by: number) =>
    Array.from({ length: Math.round((to - from) / by) + 1 }, (_, i) => Number((from + i * by).toFixed(4)));
  const HBA1C_VALUES = [...steps(36, 50, 0.05), HBA1C_PRE, HBA1C_DIA, 38.79, 38.8, 47.52, 47.53, 47.54];
  const LPA_VALUES = [...steps(60, 140, 0.05), 74.99, 124.99];
  const UNITS = ['conventional', 'si'] as const;

  it('grades and cards are unchanged: the same card and tile status as the written-out lines (passes before and after)', () => {
    for (const v of HBA1C_VALUES) {
      for (const u of UNITS) {
        const view = hba1cView(v, u);
        expect(view.id, `${v} ${u}`).toBe(`hba1c-${hba1cGrade(v)}`);
        expect(view.status, `${v} ${u}`).toBe(TILE[hba1cGrade(v)]);
      }
    }
    for (const v of LPA_VALUES) {
      const view = lpaView(v);
      expect(view.id, `${v}`).toBe(`lpa-${lpaGrade(v)}`);
      expect(view.status, `${v}`).toBe(TILE[lpaGrade(v)]);
    }
  });

  it('HbA1c 36 to 50 mmol/mol: the tile and card print one number, on its grade\'s side, in % and mmol/mol', () => {
    // Lines as each unit prints them: 5.7/6.5 %, and 39/48 mmol/mol (the first whole number graded past 38.8/47.5).
    const lines = { conventional: [5.7, 6.5], si: [39, 48] } as const;
    for (const v of HBA1C_VALUES) {
      for (const u of UNITS) {
        const view = hba1cView(v, u);
        expect(view.tile, `${v} ${u}`).toBe(view.printed);
        const n = Number(view.printed);
        const [pre, dia] = lines[u];
        const side = n >= dia ? 'diabetic' : n >= pre ? 'prediabetic' : 'normal';
        expect(side, `${v} ${u} printed ${view.printed}`).toBe(hba1cGrade(v));
      }
    }
  });

  it('Lp(a) 60 to 140 nmol/L: the tile and card print one number, on its grade\'s side', () => {
    for (const v of LPA_VALUES) {
      const view = lpaView(v);
      expect(view.tile, `${v}`).toBe(view.printed);
      const n = Number(view.printed);
      expect(n >= 125 ? 'elevated' : n >= 75 ? 'borderline' : 'normal', `${v} printed ${view.printed}`).toBe(lpaGrade(v));
    }
  });
});

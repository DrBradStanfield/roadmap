// The summary tiles at the top of the plan: the web's Quick Stats (ResultsPanel.tsx)
// and the phone's My plan tiles (US-25 AC22). One source for which tiles show, in what
// order, with what words and status; each surface only draws them.
import type { HealthResults } from './types';
import type { SuggestionEvidence } from './evidence';
import { STAT_CARD_EVIDENCE, getBmiEvidence, getIbwEvidence, getProteinEvidence } from './evidence';
import { getEgfrStatus, getHba1cStatus, getLipidStatus, getLpaStatus, getProteinRate } from './calculations';
import { lipidMarkerFor, type LipidMarker } from './suggestions';
import { LIMIT_NOT_GRADED, formatLimit, limitLabelValue, limitText, withComparator, type LimitField } from './lab-limits';
import {
  APOB_THRESHOLDS, LDL_THRESHOLDS, NON_HDL_THRESHOLDS, formatDisplayValue, formatGradedValue, formatHeightDisplay,
  getDisplayLabel, isWaistToHeightElevated, type MetricType, type UnitSystem,
} from './units';

/** A status's weight: the web's `status-*` class without its prefix. */
export type StatTone = 'normal' | 'info' | 'attention' | 'urgent';

export interface StatTileStatus { label: string; tone?: StatTone }

/** Every tile's stable key. */
export type StatTileKey = 'whtr' | 'bmi' | 'ibw' | 'protein' | 'apoB' | 'nonHdl' | 'ldl' | 'egfr' | 'lpa' | 'hba1c';

export interface StatTile {
  key: StatTileKey;
  label: string;
  value: string;
  /** The unit after the value; '' when the value has none (BMI, waist-to-height). */
  unit: string;
  /** Absent where none shows: a known minor's readings, BMI 25-29.9 with no waist. */
  status?: StatTileStatus;
  /** What a tap opens. */
  evidence?: SuggestionEvidence;
  /** What the tile is, in plain words (US-57 AC5); kept for a known minor's tile too. */
  about: string;
}

/**
 * What each tile is, one to three plain sentences (US-57 AC5, approved by Brad 2026-10-25).
 * No threshold and no grading, so a line never disagrees with the tile's status or its
 * evidence. A known minor's tiles keep these lines, except BMI, which reads
 * STAT_TILE_ABOUT_MINOR_BMI (US-07 AC6). Definitions only: outside the
 * three-file sync (Brad, 2026-10-25). The phone shows them; the web may later.
 */
export const STAT_TILE_ABOUT: Record<StatTileKey, string> = {
  whtr: 'Your waist measurement divided by your height. It shows how much weight you carry around your middle, which BMI cannot show.',
  bmi: 'Body mass index: your weight in kilograms divided by your height in metres, squared. It cannot tell muscle from fat, so your waist measurement can change how the plan reads it.',
  ibw: 'A healthy weight for your height and sex, from the Peterson formula (2016). The plan sets your protein target from it, not from your current weight.',
  protein: 'How much protein to eat each day, set from your ideal body weight. Enough protein helps you keep muscle, more so after 40.',
  apoB: 'Apolipoprotein B counts the particles in your blood that can build up in artery walls. The plan prefers it to the other cholesterol tests because it predicts heart risk most closely.',
  nonHdl: 'Your total cholesterol minus your HDL cholesterol: the cholesterol in every particle that can build up in artery walls. The plan uses it when there is no ApoB result.',
  ldl: 'The cholesterol carried by LDL particles, the main kind that builds up in artery walls. The plan uses it when there is no ApoB or non-HDL result.',
  egfr: 'Estimated glomerular filtration rate: how well your kidneys filter your blood, worked out from a creatinine blood test, your age and your sex.',
  lpa: 'Lipoprotein(a), a cholesterol particle whose level is set mostly by your genes. Diet and exercise change it little, so one test in a lifetime is usually enough.',
  hba1c: 'Your average blood sugar over the last two to three months, from one blood test.',
};

/** The eGFR line when the number is the lab's own (US-07 AC7). */
export const STAT_TILE_ABOUT_LAB_EGFR = 'Estimated glomerular filtration rate: how well your kidneys filter your blood, as printed on your lab report.';

/** A known minor's BMI line in place of the adult one (US-07 AC6, Brad 2026-10-25). */
export const STAT_TILE_ABOUT_MINOR_BMI = 'Body mass index: your weight in kilograms divided by your height in metres, squared. For under-18s the plan doesn\'t grade BMI, because children are compared with growth charts instead.';

export interface StatTileOptions {
  unitSystem: UnitSystem;
  /** Per-test display units (US-05 per-field toggles); absent, `unitSystem` throughout. */
  unitOverrides?: Partial<Record<MetricType, UnitSystem>>;
  sex?: 'male' | 'female';
}

// Status word to tone, for the graded tiles.
const TONES: Record<string, StatTone> = {
  'Normal': 'normal', 'Optimal': 'normal', 'Healthy': 'normal',
  'Low Normal': 'info', 'Borderline': 'info', 'Above optimal': 'info', 'Overweight': 'info',
  'Mildly Decreased': 'attention', 'High': 'attention', 'Elevated': 'attention',
  'Moderately Decreased': 'attention', 'Underweight': 'attention',
  'Prediabetic': 'attention',
  'Very High': 'urgent', 'Severely Decreased': 'urgent', 'Kidney Failure': 'urgent',
  'Diabetic': 'urgent',
};

const graded = (label: string): StatTileStatus => ({ label, tone: TONES[label] });

/** A limit's tile status when the bound does not decide: no tone, as no grade (US-12 AC20). */
export const NOT_GRADED: StatTileStatus = { label: 'Printed as a limit: not graded' };

const BMI_TONES: Record<string, StatTone> = { Underweight: 'attention', Normal: 'normal', Overweight: 'info' };

/** BMI's status. With BMI 25-29.9 and no waist, none: the plan asks for the waist instead. */
function bmiTileStatus(category: string, waistToHeightRatio?: number): StatTileStatus | undefined {
  if (category === 'Overweight' && waistToHeightRatio === undefined) return undefined;
  if (category.startsWith('Obese')) return { label: 'Obese', tone: 'attention' };
  return { label: category, tone: BMI_TONES[category] };
}

function waistToHeightTileStatus(ratio: number): StatTileStatus {
  return isWaistToHeightElevated(ratio) ? { label: 'Elevated', tone: 'attention' } : { label: 'Healthy', tone: 'normal' };
}

/** The lipid tile for each kind of the plan's lipid marker (ApoB, then non-HDL, then LDL). */
const LIPID_TILES: Record<LipidMarker['kind'], { label: string; thresholds: Parameters<typeof getLipidStatus>[1]; metric: MetricType; evidence: string }> = {
  apoB: { label: 'ApoB', thresholds: APOB_THRESHOLDS, metric: 'apob', evidence: 'apob' },
  nonHdl: { label: 'Non-HDL Cholesterol', thresholds: NON_HDL_THRESHOLDS, metric: 'ldl', evidence: 'non-hdl' },
  ldl: { label: 'LDL Cholesterol', thresholds: LDL_THRESHOLDS, metric: 'ldl', evidence: 'ldl' },
};

/** The tiles for a plan's results, in display order. */
export function statTiles(results: HealthResults, { unitSystem, unitOverrides, sex }: StatTileOptions): StatTile[] {
  const usFor = (metric: MetricType): UnitSystem => unitOverrides?.[metric] ?? unitSystem;
  // US-07 AC6: a known minor's tiles keep the values and drop every adult reading.
  const adult = !results.knownMinor;
  const reading = <T>(value: T): T | undefined => (adult ? value : undefined);
  const tiles: Omit<StatTile, 'about'>[] = [];

  if (results.waistToHeightRatio !== undefined) {
    tiles.push({
      key: 'whtr', label: 'Waist-to-Height', value: String(results.waistToHeightRatio), unit: '',
      status: waistToHeightTileStatus(results.waistToHeightRatio), evidence: STAT_CARD_EVIDENCE['whtr'],
    });
  }
  if (results.bmi !== undefined) {
    tiles.push({
      key: 'bmi', label: 'BMI', value: String(results.bmi), unit: '',
      status: reading(bmiTileStatus(results.bmiCategory!, results.waistToHeightRatio)),
      evidence: sex ? reading(getBmiEvidence(results.bmi, sex, results.waistToHeightRatio)) : undefined,
    });
  }
  // Both need sex (US-07 AC8).
  if (adult && results.idealBodyWeight !== undefined && results.proteinTarget !== undefined) {
    tiles.push({
      key: 'ibw', label: 'Ideal Body Weight',
      value: formatDisplayValue('weight', results.idealBodyWeight, usFor('weight')), unit: getDisplayLabel('weight', usFor('weight')),
      // Height reads in the plan's units: it has no per-test toggle.
      // No tone: a fact, not a grade, so neutral gray (Brad 2026-10-31).
      status: { label: `for ${formatHeightDisplay(results.heightCm, unitSystem)} height` },
      evidence: sex ? getIbwEvidence(sex) : undefined,
    });
    const rate = getProteinRate(results.eGFR);
    tiles.push({
      key: 'protein', label: 'Protein Target', value: String(results.proteinTarget), unit: 'g/day',
      status: { label: `${rate.toFixed(1)} g/kg ideal weight` },
      evidence: getProteinEvidence(results.idealBodyWeight, rate, results.eGFR),
    });
  }
  // A limit the plan graded shows its tile word only when it also decides
  // against the tile's own lines; else the tile shows the limit with no word (US-12 AC20).
  const worded = (field: LimitField) => {
    const limit = results.limits?.[field];
    return !limit || limitLabelValue(field, limit.comparator, limit.bound) !== null;
  };
  // Results carry ApoB and LDL through from the inputs.
  const marker = lipidMarkerFor(results, results);
  if (marker) {
    const tile = LIPID_TILES[marker.kind];
    const u = usFor(tile.metric);
    tiles.push({
      key: marker.kind, label: tile.label,
      // The value reads on the side of the marker's target that its status grades it (US-07 AC5);
      // a limit reads as printed (US-12 AC20).
      value: marker.limit ? formatLimit(tile.metric, marker.limit, u) : formatGradedValue(tile.metric, marker.value, u, marker.target),
      unit: getDisplayLabel(tile.metric, u),
      status: marker.kind !== 'nonHdl' && !worded(marker.kind === 'apoB' ? 'apoB' : 'ldlC') ? undefined
        : reading(graded(getLipidStatus(marker.value, tile.thresholds))),
      evidence: reading(STAT_CARD_EVIDENCE[tile.evidence]),
    });
  }
  // A limit that does not decide is shown as printed, with no grade (US-12 AC20).
  const ungraded = (field: LimitField) => (results.limits?.[field]?.graded === false ? results.limits[field] : undefined);
  for (const [field, key, label, metric] of [['apoB', 'apoB', 'ApoB', 'apob'], ['ldlC', 'ldl', 'LDL Cholesterol', 'ldl']] as const) {
    const limit = ungraded(field);
    if (limit && marker?.kind !== key) {
      tiles.push({ key, label, value: formatLimit(metric, limit, usFor(metric)), unit: getDisplayLabel(metric, usFor(metric)), status: NOT_GRADED });
    }
  }
  const egfrLimit = results.limits?.labEgfr;
  if (adult && (results.eGFR !== undefined || egfrLimit)) {
    tiles.push({
      key: 'egfr', label: 'eGFR', value: egfrLimit ? withComparator(String(egfrLimit.bound), egfrLimit.comparator) : String(results.eGFR), unit: 'mL/min',
      status: results.eGFR === undefined ? NOT_GRADED : worded('labEgfr') ? graded(getEgfrStatus(results.eGFR)) : undefined, evidence: STAT_CARD_EVIDENCE['egfr'],
    });
  }
  const lpaLimit = results.limits?.lpa;
  if (results.lpa !== undefined || lpaLimit) {
    tiles.push({
      key: 'lpa', label: 'Lp(a)', value: lpaLimit ? limitText(lpaLimit.bound, 0, lpaLimit.comparator) : String(Math.round(results.lpa!)), unit: 'nmol/L',
      status: results.lpa === undefined ? NOT_GRADED : worded('lpa') ? reading(graded(getLpaStatus(results.lpa))) : undefined, evidence: reading(STAT_CARD_EVIDENCE['lpa']),
    });
  }
  const hba1cLimit = results.limits?.hba1c;
  if (results.hba1c !== undefined || hba1cLimit) {
    tiles.push({
      key: 'hba1c', label: 'HbA1c',
      value: hba1cLimit ? formatLimit('hba1c', hba1cLimit, usFor('hba1c')) : formatDisplayValue('hba1c', results.hba1c!, usFor('hba1c')),
      unit: getDisplayLabel('hba1c', usFor('hba1c')),
      status: results.hba1c === undefined ? NOT_GRADED : worded('hba1c') ? reading(graded(getHba1cStatus(results.hba1c))) : undefined, evidence: reading(STAT_CARD_EVIDENCE['hba1c']),
    });
  }
  return tiles.map((t) => ({
    ...t,
    about: `${!adult && t.key === 'bmi' ? STAT_TILE_ABOUT_MINOR_BMI
      : t.key === 'egfr' && (results.eGFRFromLab || results.limits?.labEgfr) ? STAT_TILE_ABOUT_LAB_EGFR : STAT_TILE_ABOUT[t.key]}${t.status === NOT_GRADED ? ` ${LIMIT_NOT_GRADED}` : ''}`,
  }));
}

/** A tile's value and unit as one line, as the web prints it: "72g/day", "60.0 kg", "25.2". */
export function statTileText(tile: StatTile): string {
  if (!tile.unit) return tile.value;
  return `${tile.value}${tile.key === 'protein' ? '' : ' '}${tile.unit}`;
}

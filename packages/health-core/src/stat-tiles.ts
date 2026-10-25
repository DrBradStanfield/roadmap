// The summary tiles at the top of the plan: the web's Quick Stats (ResultsPanel.tsx)
// and the phone's My plan tiles (US-25 AC22). One source for which tiles show, in what
// order, with what words and status; each surface only draws them.
import type { HealthResults } from './types';
import type { SuggestionEvidence } from './evidence';
import { STAT_CARD_EVIDENCE, getBmiEvidence, getIbwEvidence, getProteinEvidence } from './evidence';
import { getEgfrStatus, getHba1cStatus, getLipidStatus, getLpaStatus, getProteinRate } from './calculations';
import { lipidMarkerFor, type LipidMarker } from './suggestions';
import {
  APOB_THRESHOLDS, LDL_THRESHOLDS, NON_HDL_THRESHOLDS, formatDisplayValue, formatGradedValue, formatHeightDisplay,
  getDisplayLabel, isWaistToHeightElevated, type MetricType, type UnitSystem,
} from './units';

/** A status's weight: the web's `status-*` class without its prefix. */
export type StatTone = 'normal' | 'info' | 'attention' | 'urgent';

export interface StatTileStatus { label: string; tone?: StatTone }

export interface StatTile {
  /** Stable per tile: whtr, bmi, ibw, protein, apoB, nonHdl, ldl, egfr, lpa, hba1c. */
  key: string;
  label: string;
  value: string;
  /** The unit after the value; '' when the value has none (BMI, waist-to-height). */
  unit: string;
  /** Absent where none shows: a known minor's readings, BMI 25-29.9 with no waist. */
  status?: StatTileStatus;
  /** What a tap opens. */
  evidence?: SuggestionEvidence;
  /** What the tile is, in plain words (US-57 AC5); kept for a known minor's tile too. */
  about?: string;
}

/**
 * What each tile is, one to three plain sentences (US-57 AC5, approved by Brad 2026-10-25).
 * No threshold and no grading, so a line never disagrees with the tile's status or its
 * evidence, and suits a known minor's tile (US-07 AC6). Definitions only: outside the
 * three-file sync (Brad, 2026-10-25). The phone shows them; the web may later.
 */
export const STAT_TILE_ABOUT: Record<string, string> = {
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
  const tiles: StatTile[] = [];

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
  if (adult) {
    tiles.push({
      key: 'ibw', label: 'Ideal Body Weight',
      value: formatDisplayValue('weight', results.idealBodyWeight, usFor('weight')), unit: getDisplayLabel('weight', usFor('weight')),
      // Height reads in the plan's units: it has no per-test toggle.
      status: { label: `for ${formatHeightDisplay(results.heightCm, unitSystem)} height`, tone: 'normal' },
      evidence: sex ? getIbwEvidence(sex) : undefined,
    });
    const rate = getProteinRate(results.eGFR);
    tiles.push({
      key: 'protein', label: 'Protein Target', value: String(results.proteinTarget), unit: 'g/day',
      status: { label: `${rate.toFixed(1)}g per kg IBW`, tone: 'normal' },
      evidence: getProteinEvidence(results.idealBodyWeight, rate, results.eGFR),
    });
  }
  // Results carry ApoB and LDL through from the inputs.
  const marker = lipidMarkerFor(results, results);
  if (marker) {
    const tile = LIPID_TILES[marker.kind];
    const u = usFor(tile.metric);
    tiles.push({
      key: marker.kind, label: tile.label,
      // The value reads on the side of the marker's target that its status grades it (US-07 AC5).
      value: formatGradedValue(tile.metric, marker.value, u, marker.target), unit: getDisplayLabel(tile.metric, u),
      status: reading(graded(getLipidStatus(marker.value, tile.thresholds))),
      evidence: reading(STAT_CARD_EVIDENCE[tile.evidence]),
    });
  }
  if (adult && results.eGFR !== undefined) {
    tiles.push({
      key: 'egfr', label: 'eGFR', value: String(results.eGFR), unit: 'mL/min',
      status: graded(getEgfrStatus(results.eGFR)), evidence: STAT_CARD_EVIDENCE['egfr'],
    });
  }
  if (results.lpa !== undefined) {
    tiles.push({
      key: 'lpa', label: 'Lp(a)', value: String(Math.round(results.lpa)), unit: 'nmol/L',
      status: reading(graded(getLpaStatus(results.lpa))), evidence: reading(STAT_CARD_EVIDENCE['lpa']),
    });
  }
  if (results.hba1c !== undefined) {
    tiles.push({
      key: 'hba1c', label: 'HbA1c',
      value: formatDisplayValue('hba1c', results.hba1c, usFor('hba1c')), unit: getDisplayLabel('hba1c', usFor('hba1c')),
      status: reading(graded(getHba1cStatus(results.hba1c))), evidence: reading(STAT_CARD_EVIDENCE['hba1c']),
    });
  }
  return tiles.map((t) => ({ ...t, about: STAT_TILE_ABOUT[t.key] }));
}

/** A tile's value and unit as one line, as the web prints it: "72g/day", "60.0 kg", "25.2". */
export function statTileText(tile: StatTile): string {
  if (!tile.unit) return tile.value;
  return `${tile.value}${tile.key === 'protein' ? '' : ' '}${tile.unit}`;
}

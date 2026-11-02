// The iPhone chat's edits to the record (US-67). The server sends the edits
// it parsed (`proposedEdits`); this file reads them again, as any input from
// the network, and writes them by the web's rules, through health-core's own
// writes. Two parts: the medications save at once with Undo, as on the web
// (US-06 AC12); values and the profile wait for Save in a banner, and save as
// one write, all or none (AC4). `chatEditsPreview` is what each part would do,
// from the same function that writes it, so the banner and the write agree.
import type { RoadmapFile } from '../../packages/health-core/src/roadmap-file';
import {
  chatMedicationChange, readProposedEdits, unsavedProfile,
  type ChatMedicationRow, type ProposedEdit, type ProposedFieldEdit, type ProposedMedicationEdit, type ProposedProfileEdit,
} from '../../packages/health-core/src/chat-edits';
import { FIELD_TO_METRIC, METRIC_LABELS } from '../../packages/health-core/src/mappings';
import { latestDayOnEarth } from '../../packages/health-core/src/merge';
import { appendMeasurement, correctValue, findActiveInSlot, measurementValueFault, resolveRecordedAt } from '../../packages/health-core/src/record-edits';
import { updateProfile } from '../../packages/health-core/src/mcp-tools';
import { upsertMedication } from '../../packages/health-core/src/state-edits';
import { medicationSchema, PRESSURE_ORDER } from '../../packages/health-core/src/validation';
import { cmToFeetInches, getDisplayLabel, toCanonicalValue, type MetricType } from '../../packages/health-core/src/units';
import { cellLabel, cellText } from '../../packages/health-core/src/cell-unit';
import { BEMPEDOIC_ACID_OPTIONS, GLP1_NAMES, METFORMIN_OPTIONS, SGLT2I_NAMES, STATIN_NAMES } from '../../packages/health-core/src/types';
import { applyPressure } from './blood-pressure';
import { cellUnitFor, unitsOf, type UnitChoices } from './unit-choices';

/** The chat's edits, as Swift passes them back to cloudEdit or applyEditJson. */
export type ChatEdit =
  /** One part of a reply's `proposedEdits`, exactly as the server sent them. `today`: the phone's day, YYYY-MM-DD.
   *  `seen`: the review preview's `seen`, passed back as it came; when the record no longer
   *  holds what the banner named, the review part is refused (US-67 AC3). */
  | { kind: 'chatEdits'; part: 'medications' | 'review'; edits: unknown; today: string; seen?: unknown }
  /** The medications part's Undo: each row as it was, written in order (chatEditsPreview's `undo`). */
  | { kind: 'chatUndo'; medications: ChatMedicationRow[] };

export interface ChatLine { text: string }
export interface ChatReviewLine { text: string; replaces: string | null }

export interface ChatEditsPreview {
  medications: { lines: ChatLine[]; undo: ChatEdit } | null;
  /** `seen`: opaque to Swift. The rows and profile values the lines name, as the record held them. */
  review: { lines: ChatReviewLine[]; refusal: string | null; seen: Seen } | null;
}

/** For each line, in order: its key and what the record held there (a row id, a pair's ids, a profile value, or null). */
type Seen = Array<[string, unknown]>;

type Outcome = { ok: true; file: RoadmapFile } | { ok: false; reason: string; message: string };

const UNREADABLE = 'The chat\'s suggestion could not be read, so nothing was saved.';
const NOTHING_SAVED = 'Nothing was saved.';
const STALE = `Your record changed on another device while this was shown. ${NOTHING_SAVED}`;

/** What each part of a reply would do to `file`. Nothing is written. */
export function chatEditsPreview(file: RoadmapFile, rawEdits: unknown, now: string, today: string, choices: UnitChoices = {}): ChatEditsPreview {
  const read = readProposedEdits(rawEdits);
  const meds = medicationPart(file, read.edits, read.invalid, now);
  const review = reviewPart(file, read.edits, read.invalid, today, now, choices);
  return {
    medications: meds.ok && meds.lines.length > 0 ? { lines: meds.lines, undo: { kind: 'chatUndo', medications: meds.undo } } : null,
    review: review.lines.length > 0 || review.refusal ? { lines: review.lines, refusal: review.refusal, seen: review.seen } : null,
  };
}

/** A ChatEdit, applied: a refusal leaves the record as it was. */
export function applyChatEdit(file: RoadmapFile, edit: ChatEdit, now: string, choices: UnitChoices = {}): Outcome {
  if (edit.kind === 'chatUndo') return undoMedications(file, edit.medications, now);
  const read = readProposedEdits(edit.edits);
  if (edit.part === 'medications') {
    const meds = medicationPart(file, read.edits, read.invalid, now);
    return meds.ok ? { ok: true, file: meds.file } : { ok: false, reason: 'invalid-value', message: UNREADABLE };
  }
  if (edit.part !== 'review') return { ok: false, reason: 'invalid-value', message: UNREADABLE };
  const review = reviewPart(file, read.edits, read.invalid, edit.today, now, choices);
  // The banner named values another device has since changed: its "replaces" would be wrong.
  if (edit.seen !== undefined && JSON.stringify(edit.seen) !== JSON.stringify(review.seen)) {
    return { ok: false, reason: 'record-changed', message: STALE };
  }
  return review.refusal ? { ok: false, reason: 'chat-refused', message: review.refusal } : { ok: true, file: review.file };
}

// --- Medications: saved at once, with Undo ----------------------------------

/**
 * Every medication edit of the reply, in order, by the web's rule (health-core
 * `chatMedicationChange`): a new drug or dose resets the drug's held escalation
 * answer unless the reply states it. An edit that matches the row already held
 * writes nothing. `undo`: the rows as they were, last edit first.
 */
function medicationPart(file: RoadmapFile, edits: ProposedEdit[], invalid: string[], now: string):
  { ok: true; file: RoadmapFile; lines: ChatLine[]; undo: ChatMedicationRow[] } | { ok: false } {
  if (invalid.includes('medication') || invalid.includes('list')) return { ok: false };
  const meds = edits.filter((e): e is ProposedMedicationEdit => e.kind === 'medication');
  const stated = new Set(meds.map((e) => e.medicationKey));
  const saved = file.medications;
  let next = file;
  const lines: ChatLine[] = [];
  const undo: ChatMedicationRow[] = [];
  for (const edit of meds) {
    const held = next.medications.find((m) => m.medicationKey === edit.medicationKey);
    if (held && held.drugName === edit.drugName && held.doseValue === edit.doseValue && held.doseUnit === edit.doseUnit) continue;
    const change = chatMedicationChange(edit, saved, stated);
    if (change.reset && change.undo.some((m) => m.medicationKey === change.reset)) {
      next = upsertMedication(next, { medicationKey: change.reset, drugName: 'not_yet', doseValue: null, doseUnit: null }, now).file;
    }
    next = upsertMedication(next, { medicationKey: edit.medicationKey, drugName: edit.drugName, doseValue: edit.doseValue, doseUnit: edit.doseUnit }, now).file;
    undo.unshift(...change.undo);
    lines.push({ text: medicationLine(edit) });
  }
  return { ok: true, file: next, lines, undo };
}

function undoMedications(file: RoadmapFile, rows: unknown, now: string): Outcome {
  if (!Array.isArray(rows)) return { ok: false, reason: 'invalid-value', message: 'This undo could not be read, so nothing changed.' };
  let next = file;
  for (const row of rows) {
    const checked = medicationSchema.safeParse(row);
    if (!checked.success) return { ok: false, reason: 'invalid-value', message: 'This undo could not be read, so nothing changed.' };
    const { medicationKey, drugName, doseValue = null, doseUnit = null } = checked.data;
    next = upsertMedication(next, { medicationKey, drugName, doseValue, doseUnit }, now).file;
  }
  return { ok: true, file: next };
}

const MEDICATION_NAMES: Record<string, string> = {
  statin: 'Statin', ezetimibe: 'Ezetimibe', statin_escalation: 'Statin higher dose or switch', pcsk9i: 'PCSK9 inhibitor',
  bempedoic_acid: 'Bempedoic acid', glp1: 'GLP-1 medication', glp1_escalation: 'GLP-1 higher dose or switch',
  sglt2i: 'SGLT2 inhibitor', metformin: 'Metformin',
};
/** The answers the chat may give for any key, in the form's words; 'none' is "not taking" here, not "haven't tried". */
const STATUS_WORDS: Record<string, string> = { none: 'Not taking', not_yet: 'Not yet', yes: 'Yes', no: 'No', not_tolerated: 'Not tolerated' };
const DRUG_WORDS = new Map<string, string>(
  [...STATIN_NAMES, ...BEMPEDOIC_ACID_OPTIONS, ...GLP1_NAMES, ...SGLT2I_NAMES, ...METFORMIN_OPTIONS].map((o) => [o.value, o.label]),
);

/** "Statin: Atorvastatin 20 mg". */
function medicationLine(edit: ProposedMedicationEdit): string {
  const own = Object.prototype.hasOwnProperty.call(STATUS_WORDS, edit.drugName) ? STATUS_WORDS[edit.drugName] : DRUG_WORDS.get(edit.drugName);
  const drug = own ?? edit.drugName.charAt(0).toUpperCase() + edit.drugName.slice(1).replace(/_/g, ' ');
  const dose = edit.doseValue !== null ? ` ${edit.doseValue}${edit.doseUnit ? ` ${edit.doseUnit}` : ''}` : '';
  return `${MEDICATION_NAMES[edit.medicationKey] ?? edit.medicationKey}: ${drug}${dose}`;
}

// --- Values and the profile: one Save, all or none ---------------------------

const BP_FIELDS = new Set(['systolicBp', 'diastolicBp']);

/**
 * The field and profile edits of a reply as one write. Each value goes from
 * its stated unit to SI by health-core's conversion; one per metric and day,
 * the later stated winning. A blood pressure is a pair from one day, written
 * by the phone's own pair write (both or neither). A day that already holds a
 * value becomes a correction (rows are never changed: correctsId and
 * entered-in-error); the same value again writes nothing. The profile writes
 * only what it does not already hold (the web's unsavedProfile). The first
 * refusal refuses the whole part. Lines are in the phone's units. `seen`:
 * what the record held for each line, so a Save can tell the record moved.
 */
function reviewPart(file: RoadmapFile, edits: ProposedEdit[], invalid: string[], today: string, now: string, choices: UnitChoices):
  { file: RoadmapFile; lines: ChatReviewLine[]; refusal: string | null; seen: Seen } {
  const lines: ChatReviewLine[] = [];
  const seen: Seen = [];
  const refuse = (message: string) => ({ file, lines, seen, refusal: `${message} ${NOTHING_SAVED}` });
  if (invalid.includes('field') || invalid.includes('profile') || invalid.includes('list')) return { file, lines, seen, refusal: UNREADABLE };
  const fields = edits.filter((e): e is ProposedFieldEdit => e.kind === 'field');
  const profiles = edits.filter((e): e is ProposedProfileEdit => e.kind === 'profile');
  if (fields.length === 0 && profiles.length === 0) return { file, lines, seen, refusal: null };
  if (!isRealDay(today) || today > latestDayOnEarth(now)) return refuse('This iPhone\'s date could not be read.');

  // One value per metric and day, the later stated winning; the first one's place in the reply kept.
  const values = new Map<string, { metric: MetricType; day: string; valueSI: number; edit: ProposedFieldEdit }>();
  const pressures = new Map<string, { systolic?: number; diastolic?: number }>();
  const order: string[] = [];
  for (const edit of fields) {
    const metric = FIELD_TO_METRIC[edit.field] as MetricType;
    const label = METRIC_LABELS[metric] ?? metric;
    const day = edit.date ?? today;
    const resolved = resolveRecordedAt(day, { now, latestDay: today });
    if (typeof resolved !== 'string') {
      return refuse(resolved.reason === 'future-date' ? `${label}: ${dayText(day, today)} has not happened yet.` : `${label}: ${day} is not a real date.`);
    }
    const valueSI = toCanonicalValue(metric, edit.displayValue, edit.unitSystem);
    if (measurementValueFault(metric, valueSI)) {
      return refuse(`${label} ${edit.displayValue} ${getDisplayLabel(metric, edit.unitSystem)} is outside what the record accepts.`);
    }
    const key = BP_FIELDS.has(edit.field) ? `bp:${resolved}` : `${metric}:${resolved}`;
    if (!order.includes(key)) order.push(key);
    if (BP_FIELDS.has(edit.field)) {
      const pair = pressures.get(key) ?? {};
      pair[edit.field === 'systolicBp' ? 'systolic' : 'diastolic'] = valueSI;
      pressures.set(key, pair);
    } else {
      values.set(key, { metric, day: resolved, valueSI, edit });
    }
  }

  let next = file;
  for (const key of order) {
    const pair = pressures.get(key);
    if (pair) {
      const day = key.slice(3);
      if (pair.systolic === undefined || pair.diastolic === undefined) {
        return refuse('A blood pressure needs both numbers from the same day.');
      }
      const held = (['systolic_bp', 'diastolic_bp'] as const).map((metric) => findActiveInSlot(file, 'measurement', metric, day));
      const same = held[0]?.value === pair.systolic && held[1]?.value === pair.diastolic;
      if (same) continue;
      const result = applyPressure(next, {
        kind: 'bloodPressure', systolic: pair.systolic, diastolic: pair.diastolic, day,
        replace: true, seenIds: held.flatMap((row) => (row ? [row.id] : [])),
      }, now);
      if (!result.ok) return refuse(result.message === PRESSURE_ORDER ? PRESSURE_ORDER : `Blood pressure on ${dayText(day, today)} could not be saved.`);
      next = result.file;
      const was = held.some(Boolean) ? `${held[0] ? Math.round(held[0].value) : '–'}/${held[1] ? Math.round(held[1].value) : '–'} mmHg` : null;
      lines.push({ text: `Blood pressure ${Math.round(pair.systolic)}/${Math.round(pair.diastolic)} mmHg ${dayText(day, today)}`, replaces: was });
      seen.push([key, held.map((row) => row?.id ?? null)]);
      continue;
    }
    const { metric, day, valueSI } = values.get(key)!;
    const shown = cellUnitFor(file, metric, choices);
    const label = METRIC_LABELS[metric] ?? metric;
    const held = findActiveInSlot(file, 'measurement', metric, day);
    if (held && Math.abs(held.value - valueSI) < 1e-9) continue;
    const result = held
      ? correctValue(next, { id: held.id, newValue: valueSI, now })
      : appendMeasurement(next, { metricType: metric, value: valueSI, recordedAt: day, now, latestDay: today });
    if (!result.ok) return refuse(`${label} on ${dayText(day, today)} could not be saved.`);
    next = result.file;
    const unit = cellLabel(metric, shown);
    lines.push({
      text: `${label} ${cellText(metric, valueSI, shown)} ${unit} ${dayText(day, today)}`,
      replaces: held ? `${cellText(metric, held.value, shown)} ${unit}` : null,
    });
    seen.push([key, held?.id ?? null]);
  }

  if (profiles.length > 0) {
    const stated = profiles.reduce((a, e) => ({ kind: 'profile', sex: e.sex ?? a.sex, heightCm: e.heightCm ?? a.heightCm }));
    const system = unitsOf(file);
    const pending = unsavedProfile(stated, file.profile, system);
    if (pending) {
      const outcome = updateProfile(next, { ...(pending.sex ? { sex: pending.sex } : null), ...(pending.heightCm !== null ? { heightCm: pending.heightCm } : null) }, now);
      if (outcome.status !== 'ok') return refuse('Your height is outside what the record accepts.');
      next = outcome.file ?? next;
      const { sex, heightCm } = file.profile;
      if (pending.sex) {
        lines.push({ text: `Sex: ${pending.sex}`, replaces: sex ?? null });
        seen.push(['profile:sex', sex ?? null]);
      }
      if (pending.heightCm !== null) {
        lines.push({ text: `Height ${heightText(pending.heightCm, system)}`, replaces: typeof heightCm === 'number' ? heightText(heightCm, system) : null });
        seen.push(['profile:heightCm', heightCm ?? null]);
      }
    }
  }
  return { file: next, lines, seen, refusal: null };
}

function heightText(cm: number, system: 'si' | 'conventional'): string {
  if (system === 'si') return `${Math.round(cm)} cm`;
  const { feet, inches } = cmToFeetInches(cm);
  return `${feet} ft ${inches} in`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "today", "on 2 Nov", or "on 2 Nov 2025" in another year. */
function dayText(day: string, today: string): string {
  if (day === today) return 'today';
  const [year, month, date] = day.split('-');
  return `on ${Number(date)} ${MONTHS[Number(month) - 1] ?? month}${year === today.slice(0, 4) ? '' : ` ${year}`}`;
}

function isRealDay(day: unknown): day is string {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  return new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day;
}

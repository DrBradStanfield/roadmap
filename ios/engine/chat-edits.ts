// The iPhone chat's edits to the record (US-67). The server sends the edits
// it parsed (`proposedEdits`); this file reads them again, as any input from
// the network, and writes them by the web's rules, through health-core's own
// writes. Two parts: the medications save at once with Undo, as on the web
// (US-06 AC12); values and the profile wait for Save in a banner, and save as
// one write, all or none (AC4). `chatEditsPreview` is what each part would do,
// from the same function that writes it, so the banner and the write agree.
import type { RoadmapFile } from '../../packages/health-core/src/roadmap-file';
import {
  chatMedicationChange, MEDICATION_ANSWERS, readProposedEdits, unsavedProfile,
  type ChatMedicationRow, type ProposedEdit, type ProposedFieldEdit, type ProposedMedicationEdit, type ProposedProfileEdit,
} from '../../packages/health-core/src/chat-edits';
import { FIELD_TO_METRIC, METRIC_LABELS } from '../../packages/health-core/src/mappings';
import { latestDayOnEarth } from '../../packages/health-core/src/merge';
import { isActive } from '../../packages/health-core/src/blood-tests';
import { appendMeasurement, correctValue, findActiveInSlot, measurementValueFault, resolveRecordedAt } from '../../packages/health-core/src/record-edits';
import { updateProfile } from '../../packages/health-core/src/mcp-tools';
import { upsertMedication } from '../../packages/health-core/src/state-edits';
import { medicationSchema, PRESSURE_ORDER } from '../../packages/health-core/src/validation';
import { cmToFeetInches, getDisplayLabel, toCanonicalValue, type MetricType } from '../../packages/health-core/src/units';
import { cellLabel, cellText } from '../../packages/health-core/src/cell-unit';
import { applyPressure } from './blood-pressure';
import { cellUnitFor, unitsOf, type UnitChoices } from './unit-choices';
import { isReadableRow, readableView } from '../../packages/health-core/src/readable-rows';
import { partRefusal } from '../../packages/health-core/src/chat-edit-refusals';

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
  /** `refusal`: the medications could not be read, so nothing is saved (lines empty, undo null).
   *  Lines with a null `undo`: saved, with no Undo, as it replaced a row this build cannot read (US-67 N3). */
  medications: { lines: ChatLine[]; undo: ChatEdit | null; refusal: string | null } | null;
  /** `seen`: opaque to Swift. The rows and profile values the lines name, as the record held them. */
  review: { lines: ChatReviewLine[]; refusal: string | null; seen: Seen } | null;
}

/** For each line, in order: its key and what the record held there (a row id, a pair's ids, a profile value, or null). */
type Seen = Array<[string, unknown]>;

type Outcome = { ok: true; file: RoadmapFile } | { ok: false; reason: string; message: string };

const UNREADABLE = 'The chat\'s suggestion could not be read, so nothing was saved.';
const NOTHING_SAVED = 'Nothing was saved.';
const STALE = `Your record changed on another device while this was shown. ${NOTHING_SAVED}`;
/** A held row or profile value this build cannot read (US-65 AC2): named, never shown. */
const UNREADABLE_HELD = 'a value this app cannot read';
const NOT_PREPARED = `This could not be prepared. ${NOTHING_SAVED}`;

/** A part's work, so a failure in one part refuses that part alone and never sinks the reply. */
function guarded<T>(work: () => T, failed: T): T {
  try {
    return work();
  } catch {
    return failed;
  }
}

/** What each part of a reply would do to `file`. Nothing is written. */
export function chatEditsPreview(file: RoadmapFile, rawEdits: unknown, now: string, today: string, choices: UnitChoices = {}): ChatEditsPreview {
  const read = readProposedEdits(rawEdits);
  const meds = guarded(() => medicationPart(file, read.edits, read.invalid, now), { ok: false as const, message: NOT_PREPARED });
  const review = guarded(() => reviewPart(file, read.edits, read.invalid, today, now, choices), { file, lines: [], seen: [], refusal: NOT_PREPARED });
  return {
    // A list that is not one is the review part's refusal alone, so the person reads it once.
    medications: !meds.ok
      ? (read.invalid.includes('list') ? null : { lines: [], undo: null, refusal: meds.message })
      : meds.lines.length > 0 ? { lines: meds.lines, undo: meds.undo && { kind: 'chatUndo', medications: meds.undo }, refusal: null } : null,
    review: review.lines.length > 0 || review.refusal ? { lines: review.lines, refusal: review.refusal, seen: review.seen } : null,
  };
}

/** A ChatEdit, applied: a refusal leaves the record as it was. */
export function applyChatEdit(file: RoadmapFile, edit: ChatEdit, now: string, choices: UnitChoices = {}): Outcome {
  if (edit.kind === 'chatUndo') return undoMedications(file, edit.medications, now);
  const read = readProposedEdits(edit.edits);
  if (edit.part === 'medications') {
    const meds = guarded(() => medicationPart(file, read.edits, read.invalid, now), { ok: false as const, message: NOT_PREPARED });
    return meds.ok ? { ok: true, file: meds.file } : { ok: false, reason: 'invalid-value', message: meds.message };
  }
  if (edit.part !== 'review') return { ok: false, reason: 'invalid-value', message: UNREADABLE };
  const review = guarded(() => reviewPart(file, read.edits, read.invalid, edit.today, now, choices), { file, lines: [], seen: [], refusal: NOT_PREPARED });
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
 * writes nothing. `undo`: the rows as they were, last edit first. Whether an
 * escalation answer is reset reads the raw record, so an answer this build
 * cannot read (US-65) is reset too. When the reply replaces any row this
 * build cannot read, `undo` is null (US-67 N3): Undo could not put it back,
 * and one Undo covers the whole reply. The changes still save.
 */
function medicationPart(file: RoadmapFile, edits: ProposedEdit[], invalid: string[], now: string):
  { ok: true; file: RoadmapFile; lines: ChatLine[]; undo: ChatMedicationRow[] | null } | { ok: false; message: string } {
  const refusal = partRefusal(invalid, 'medications');
  if (refusal) return { ok: false, message: refusal };
  const meds = edits.filter((e): e is ProposedMedicationEdit => e.kind === 'medication');
  const stated = new Set(meds.map((e) => e.medicationKey));
  const saved = readableView(file).file.medications;
  const unreadable = (key: string) => file.medications.some((m) => m.medicationKey === key && !isReadableRow('medications', m));
  let next = file;
  const lines: ChatLine[] = [];
  const undo: ChatMedicationRow[] = [];
  let undoable = true;
  for (const edit of meds) {
    const held = next.medications.find((m) => m.medicationKey === edit.medicationKey);
    if (held && held.drugName === edit.drugName && held.doseValue === edit.doseValue && held.doseUnit === edit.doseUnit) continue;
    const change = chatMedicationChange(edit, saved, stated);
    const reset = change.reset;
    if (reset && file.medications.some((m) => m.medicationKey === reset && m.drugName !== 'not_yet')) {
      if (unreadable(reset)) undoable = false;
      next = upsertMedication(next, { medicationKey: reset, drugName: 'not_yet', doseValue: null, doseUnit: null }, now).file;
    }
    if (unreadable(edit.medicationKey)) undoable = false;
    next = upsertMedication(next, { medicationKey: edit.medicationKey, drugName: edit.drugName, doseValue: edit.doseValue, doseUnit: edit.doseUnit }, now).file;
    undo.unshift(...change.undo);
    lines.push({ text: medicationLine(edit) });
  }
  return { ok: true, file: next, lines, undo: undoable ? undo : null };
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
/** "Statin: Atorvastatin 20 mg". The answer reads as its own question's form option ("Haven't tried yet" for a
 *  statin's 'none', "No" for ezetimibe's 'no'); an unlisted drug the form takes reads as its name. */
function medicationLine(edit: ProposedMedicationEdit): string {
  const own = MEDICATION_ANSWERS[edit.medicationKey].find((o) => o.value === edit.drugName)?.label;
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
 * Writes and `seen` read the raw record; the words read what this build can
 * read (US-65), so a row it cannot read is named, never shown or compared.
 */
function reviewPart(file: RoadmapFile, edits: ProposedEdit[], invalid: string[], today: string, now: string, choices: UnitChoices):
  { file: RoadmapFile; lines: ChatReviewLine[]; refusal: string | null; seen: Seen } {
  const lines: ChatReviewLine[] = [];
  const seen: Seen = [];
  const refuse = (message: string) => ({ file, lines, seen, refusal: `${message} ${NOTHING_SAVED}` });
  const refusal = partRefusal(invalid, 'review');
  if (refusal) return { file, lines, seen, refusal };
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

  const view = readableView(file).file;
  // A blood test is a core lab row (US-66 AC1), so a held value may be in either array.
  const readable = new Set([...view.measurements, ...view.labValues].map((row) => row.id));
  const shownRow = (row: { id: string; value: number } | undefined) => (row && readable.has(row.id) ? row : undefined);
  let next = file;
  for (const key of order) {
    const pair = pressures.get(key);
    if (pair) {
      const day = key.slice(3);
      if (pair.systolic === undefined || pair.diastolic === undefined) {
        return refuse('A blood pressure needs both numbers from the same day.');
      }
      const held = (['systolic_bp', 'diastolic_bp'] as const).map((metric) => findActiveInSlot(file, 'measurement', metric, day));
      const [sys, dia] = held.map(shownRow);
      const hidden = held.some((row) => row && !shownRow(row));
      if (!hidden && sys?.value === pair.systolic && dia?.value === pair.diastolic) continue;
      const result = applyPressure(next, {
        kind: 'bloodPressure', systolic: pair.systolic, diastolic: pair.diastolic, day,
        replace: true, seenIds: held.flatMap((row) => (row ? [row.id] : [])),
      }, now);
      if (!result.ok) return refuse(result.message === PRESSURE_ORDER ? PRESSURE_ORDER : `Blood pressure on ${dayText(day, today)} could not be saved.`);
      next = result.file;
      // A hidden half the pair write left as it was (its text reads as the same number) is corrected
      // too, last, against the new other half, so the banner's "replaces" is what was saved.
      for (const [index, row] of held.entries()) {
        if (!row || shownRow(row)) continue;
        // A legacy row with no status is active too (c71d283c); a row gone from the record is not.
        const stored = next.measurements.find((m) => m.id === row.id);
        if (!stored || !isActive(stored)) continue;
        const fixed = correctValue(next, { id: row.id, newValue: index === 0 ? pair.systolic : pair.diastolic, now });
        if (!fixed.ok) return refuse(`Blood pressure on ${dayText(day, today)} could not be saved.`);
        next = fixed.file;
      }
      const was = hidden ? UNREADABLE_HELD : held.some(Boolean) ? `${sys ? Math.round(sys.value) : '–'}/${dia ? Math.round(dia.value) : '–'} mmHg` : null;
      lines.push({ text: `Blood pressure ${Math.round(pair.systolic)}/${Math.round(pair.diastolic)} mmHg ${dayText(day, today)}`, replaces: was });
      seen.push([key, held.map((row) => row?.id ?? null)]);
      continue;
    }
    const { metric, day, valueSI } = values.get(key)!;
    const shown = cellUnitFor(view, metric, choices);
    const label = METRIC_LABELS[metric] ?? metric;
    const held = findActiveInSlot(file, 'measurement', metric, day);
    const was = shownRow(held);
    if (was && Math.abs(was.value - valueSI) < 1e-9) continue;
    const result = held
      ? correctValue(next, { id: held.id, newValue: valueSI, now })
      : appendMeasurement(next, { metricType: metric, value: valueSI, recordedAt: day, now, latestDay: today });
    if (!result.ok) return refuse(`${label} on ${dayText(day, today)} could not be saved.`);
    next = result.file;
    const unit = cellLabel(metric, shown);
    lines.push({
      text: `${label} ${cellText(metric, valueSI, shown)} ${unit} ${dayText(day, today)}`,
      replaces: was ? `${cellText(metric, was.value, shown)} ${unit}` : held ? UNREADABLE_HELD : null,
    });
    seen.push([key, held?.id ?? null]);
  }

  if (profiles.length > 0) {
    const stated = profiles.reduce((a, e) => ({ kind: 'profile', sex: e.sex ?? a.sex, heightCm: e.heightCm ?? a.heightCm }));
    const system = unitsOf(view);
    const pending = unsavedProfile(stated, view.profile, system);
    if (pending) {
      const outcome = updateProfile(next, { ...(pending.sex ? { sex: pending.sex } : null), ...(pending.heightCm !== null ? { heightCm: pending.heightCm } : null) }, now);
      if (outcome.status !== 'ok') return refuse('Your height is outside what the record accepts.');
      next = outcome.file ?? next;
      const { sex, heightCm } = view.profile;
      const raw = file.profile as { sex?: unknown; heightCm?: unknown };
      const held = (value: unknown, words: string | null) => words ?? (value != null ? UNREADABLE_HELD : null);
      if (pending.sex) {
        lines.push({ text: `Sex: ${pending.sex}`, replaces: held(raw.sex, sex ?? null) });
        seen.push(['profile:sex', raw.sex ?? null]);
      }
      if (pending.heightCm !== null) {
        lines.push({ text: `Height ${heightText(pending.heightCm, system)}`, replaces: held(raw.heightCm, typeof heightCm === 'number' ? heightText(heightCm, system) : null) });
        seen.push(['profile:heightCm', raw.heightCm ?? null]);
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

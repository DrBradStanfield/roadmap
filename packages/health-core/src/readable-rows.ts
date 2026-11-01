/**
 * US-65: what this build can read in a record. A row or a profile field that
 * fails here is not shown, computed with or changed: migrate.ts parks it,
 * verbatim, in the record's `unreadable` section, and every write carries it
 * back. A later build that can read it takes it back out.
 *
 * The test is the shape the code relies on, not a range: a value out of
 * range is still a reading. Missing optional fields stay readable, as they
 * always were; a field present with the wrong type, or a word this build
 * does not know (a newer app's metric, say), is not.
 */
import * as z from './zod';
import { isClinicalDay } from './measurement-history';
import { MEASUREMENT_STATUS, MEDICATION_KEYS, METRIC_TYPES } from './validation';
import { LPA_UNITS } from './units';
import { ALCOHOL_ANSWERS } from './types';
import type { RoadmapFile } from './roadmap-file';

const id = z.string().min(1);
const day = z.string().refine(isClinicalDay);
const text = z.string().nullable().optional();
const amount = z.number().nullable().optional();
const changeType = z.enum(['started', 'stopped', 'dose_changed', 'switched']).optional();

const medication = z.looseObject({
  id, medicationKey: z.enum(MEDICATION_KEYS), drugName: z.string(), doseValue: amount, doseUnit: text, changeType,
});
const supplement = z.looseObject({
  id, supplementKey: z.string(), supplementName: z.string(), doseValue: amount, doseUnit: text,
  status: z.enum(['active', 'stopped']), startedAt: text, changeType,
});

/** Each row array's test, by the record key it holds. */
const ROWS = {
  measurements: z.looseObject({
    id, metricType: z.enum(METRIC_TYPES), value: z.number(), recordedAt: day, createdAt: z.string(),
    source: z.string().optional(), status: z.enum(MEASUREMENT_STATUS), correctsId: text, externalId: text,
  }),
  labValues: z.looseObject({
    id, metricName: z.string(), value: z.number(), unit: z.string(), referenceLow: amount, referenceHigh: amount,
    recordedAt: day, createdAt: z.string(), source: z.string().optional(),
    status: z.enum(MEASUREMENT_STATUS), correctsId: text,
  }),
  medications: medication,
  medicationHistory: medication,
  supplements: supplement,
  supplementHistory: supplement,
  documents: z.looseObject({
    id, title: z.string(), type: z.string().optional(), date: text, fileRef: z.string().optional(),
    contentHash: z.string().optional(), mimeType: z.string().optional(), extractedText: z.string().optional(),
    addedAt: z.string(), metadata: z.record(z.string(), z.unknown()).optional(), sourceFileName: text,
    deleted: z.boolean().optional(),
  }),
  reminderPreferences: z.looseObject({ category: z.string(), enabled: z.boolean() }),
  recommendationSnapshots: z.looseObject({ date: z.string(), suggestions: z.array(z.unknown()) }),
} as const;

/** The record keys that hold rows. */
export type RowArray = keyof typeof ROWS;

export function isReadableRow(key: RowArray, row: unknown): boolean {
  return ROWS[key].safeParse(row).success;
}

const choice = <T extends readonly [string, ...string[]]>(words: T) => z.enum(words).nullable();
const unitSystem = choice(['si', 'conventional']);

/** The profile fields this build reads. A field not named here is a newer
 *  app's, and rides along untouched, as it always has. */
const PROFILE = {
  sex: choice(['male', 'female']),
  birthYear: z.number().nullable(),
  birthMonth: z.number().nullable(),
  heightCm: z.number().nullable(),
  unitSystem,
  unitOverrides: z.record(z.string(), z.enum(['si', 'conventional'])).nullable(),
  lpaUnit: choice(LPA_UNITS),
  reportEmailCaptured: z.boolean().nullable(),
  alcohol: choice(ALCOHOL_ANSWERS),
} as const;

/** The profile fields `isReadableProfileField` judges. */
export const PROFILE_FIELDS = Object.keys(PROFILE);

/** Whether a profile field's value is one this build reads. Absent is. */
export function isReadableProfileField(field: string, value: unknown): boolean {
  if (value === undefined || !Object.prototype.hasOwnProperty.call(PROFILE, field)) return true;
  return PROFILE[field as keyof typeof PROFILE].safeParse(value).success;
}

/** How many entries a record keeps that this build could not read: the
 *  count, and only the count, the person is told (US-65 AC5). */
export function unreadableCount(file: Pick<RoadmapFile, 'unreadable'>): number {
  return Object.entries(file.unreadable ?? {}).reduce((sum, [key, entries]) =>
    sum + (key === 'profile' ? Object.keys(entries ?? {}).length : Array.isArray(entries) ? entries.length : 0), 0);
}

/** The one line that tells the person, web and iPhone alike (US-65 AC5). */
export function unreadableNote(count: number): string | null {
  if (count <= 0) return null;
  return count === 1
    ? '1 entry in your record could not be read, so it is kept unchanged and not shown.'
    : `${count} entries in your record could not be read, so they are kept unchanged and not shown.`;
}

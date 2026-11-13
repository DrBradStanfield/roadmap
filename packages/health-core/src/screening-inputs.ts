/**
 * The screening answers as the record stores them (one row per key) read into
 * ScreeningInputs: each enum cast, each date checked, each number parsed in its
 * range. Split out of mappings.ts (which re-exports it) when screening Change 2b
 * added the colonoscopy report's follow-up time; a new screening key lands here
 * (CLAUDE.md "Adding New Screening Types", step 2).
 */
import { rangeFault, UNIT_DEFS } from './units';
import { parseLocalisedNumber } from './parseNumber';
import { followupIntervalYears } from './colonoscopy-schedule';

/** API screening record shape (camelCase, as returned by API endpoints). */
export interface ApiScreening {
  id: string;
  screeningKey: string;
  value: string;
  updatedAt: string;
}

/** Cast a DB string to a union type, returning undefined if invalid. */
function castEnum<T extends string>(value: string, valid: readonly T[]): T | undefined {
  return valid.includes(value as T) ? (value as T) : undefined;
}

/** A screening date as stored (YYYY-MM, or YYYY-MM-DD), or undefined unless it
 *  is a real calendar date: `Date` would roll '2020-99' forward into the future
 *  and call the screening up to date. A "last done" date must also fall in the month of
 *  `lastDoneBy` (now) or before it, as the form offers only past months; a follow-up date
 *  may be future. That month is the one at UTC+14, the earliest time zone, so the widget
 *  (local time) and the chat server (UTC) agree for every user. */
function screeningDate(value: string, lastDoneBy?: Date): string | undefined {
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(value);
  if (!m) return undefined;
  const [year, month, day] = [Number(m[1]), Number(m[2]), m[3] === undefined ? 1 : Number(m[3])];
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (days === undefined || day < 1 || day > days) return undefined;
  const now = lastDoneBy && new Date(lastDoneBy.getTime() + 14 * 3600_000);
  return now && year * 12 + month > now.getUTCFullYear() * 12 + now.getUTCMonth() + 1 ? undefined : value;
}

// Valid values for each screening enum field (derived from ScreeningInputs in types.ts)
const COLORECTAL_METHODS = ['fit_annual', 'colonoscopy_10yr', 'other', 'not_yet_started'] as const;
const BREAST_FREQUENCIES = ['annual', 'biennial', 'not_yet_started'] as const;
const CERVICAL_METHODS = ['hpv_every_5yr', 'pap_every_3yr', 'other', 'not_yet_started'] as const;
const SCREENING_RESULTS = ['normal', 'abnormal', 'awaiting'] as const;
const FOLLOWUP_STATUSES = ['not_organized', 'scheduled', 'completed'] as const;
const SMOKING_HISTORIES = ['never_smoked', 'former_smoker', 'current_smoker'] as const;
const LUNG_SCREENINGS = ['annual_ldct', 'not_yet_started'] as const;
const PROSTATE_DISCUSSIONS = ['not_yet', 'elected_not_to', 'will_screen'] as const;
const ENDOMETRIAL_DISCUSSIONS = ['not_yet', 'discussed'] as const;
const ENDOMETRIAL_BLEEDING = ['no', 'yes_reported', 'yes_need_to_report'] as const;
const DEXA_SCREENINGS = ['dexa_scan', 'not_yet_started'] as const;
const DEXA_RESULTS = ['normal', 'osteopenia', 'osteoporosis', 'awaiting'] as const;

/** The numeric screenings and their input ranges: pack-years as the form
 *  bounds them, PSA as its measurement does. A "1,234" answer is read
 *  against them (US-02 AC7). The colonoscopy's follow-up time saves as a
 *  number; reading keeps only a whole 1 to 10 (US-07 AC1j). */
export const SCREENING_RANGES = {
  lung_pack_years: { min: 0, max: 200 },
  prostate_psa_value: UNIT_DEFS.psa.validationRange.si,
  colorectal_followup_interval_years: { min: 1, max: 10 },
};

/** A screening key's input range, or undefined for a text answer. */
export function screeningRange(key: string): { min: number; max: number } | undefined {
  return Object.prototype.hasOwnProperty.call(SCREENING_RANGES, key) ? SCREENING_RANGES[key as keyof typeof SCREENING_RANGES] : undefined;
}

/** A numeric screening answer as the plan and the chat both read it (US-06 AC14): trimmed, parsed against its range, and inside it; else undefined. */
export function screeningNumber(key: string, value: string): number | undefined {
  const range = screeningRange(key), n = range ? parseLocalisedNumber(value, range) : undefined;
  return range && n !== undefined && !rangeFault(range, n) ? n : undefined;
}

/**
 * Convert API screening records into a ScreeningInputs object.
 */
export function screeningsToInputs(
  screenings: ReadonlyArray<Pick<ApiScreening, 'screeningKey' | 'value'>>,
  now: Date = new Date(),
): import('./types').ScreeningInputs {
  const inputs: import('./types').ScreeningInputs = {};
  for (const s of screenings) {
    switch (s.screeningKey) {
      case 'colorectal_method':
        inputs.colorectalMethod = castEnum(s.value, COLORECTAL_METHODS);
        break;
      case 'colorectal_last_date':
        inputs.colorectalLastDate = screeningDate(s.value, now);
        break;
      case 'colorectal_result':
        inputs.colorectalResult = castEnum(s.value, SCREENING_RESULTS);
        break;
      case 'colorectal_followup_status':
        inputs.colorectalFollowupStatus = castEnum(s.value, FOLLOWUP_STATUSES);
        break;
      case 'colorectal_followup_date':
        inputs.colorectalFollowupDate = screeningDate(s.value);
        break;
      case 'colorectal_followup_interval_years':
        inputs.colorectalFollowupIntervalYears = followupIntervalYears(s.value);
        break;
      case 'breast_frequency':
        inputs.breastFrequency = castEnum(s.value, BREAST_FREQUENCIES);
        break;
      case 'breast_last_date':
        inputs.breastLastDate = screeningDate(s.value, now);
        break;
      case 'breast_result':
        inputs.breastResult = castEnum(s.value, SCREENING_RESULTS);
        break;
      case 'breast_followup_status':
        inputs.breastFollowupStatus = castEnum(s.value, FOLLOWUP_STATUSES);
        break;
      case 'breast_followup_date':
        inputs.breastFollowupDate = screeningDate(s.value);
        break;
      case 'cervical_method':
        inputs.cervicalMethod = castEnum(s.value, CERVICAL_METHODS);
        break;
      case 'cervical_last_date':
        inputs.cervicalLastDate = screeningDate(s.value, now);
        break;
      case 'cervical_result':
        inputs.cervicalResult = castEnum(s.value, SCREENING_RESULTS);
        break;
      case 'cervical_followup_status':
        inputs.cervicalFollowupStatus = castEnum(s.value, FOLLOWUP_STATUSES);
        break;
      case 'cervical_followup_date':
        inputs.cervicalFollowupDate = screeningDate(s.value);
        break;
      case 'lung_smoking_history':
        inputs.lungSmokingHistory = castEnum(s.value, SMOKING_HISTORIES);
        break;
      case 'lung_pack_years':
        inputs.lungPackYears = parseLocalisedNumber(s.value, SCREENING_RANGES.lung_pack_years);
        break;
      case 'lung_screening':
        inputs.lungScreening = castEnum(s.value, LUNG_SCREENINGS);
        break;
      case 'lung_last_date':
        inputs.lungLastDate = screeningDate(s.value, now);
        break;
      case 'lung_result':
        inputs.lungResult = castEnum(s.value, SCREENING_RESULTS);
        break;
      case 'lung_followup_status':
        inputs.lungFollowupStatus = castEnum(s.value, FOLLOWUP_STATUSES);
        break;
      case 'lung_followup_date':
        inputs.lungFollowupDate = screeningDate(s.value);
        break;
      case 'prostate_discussion':
        inputs.prostateDiscussion = castEnum(s.value, PROSTATE_DISCUSSIONS);
        break;
      case 'prostate_psa_value':
        inputs.prostatePsaValue = screeningNumber(s.screeningKey, s.value);
        break;
      case 'prostate_last_date':
        inputs.prostateLastDate = screeningDate(s.value, now);
        break;
      case 'endometrial_discussion':
        inputs.endometrialDiscussion = castEnum(s.value, ENDOMETRIAL_DISCUSSIONS);
        break;
      case 'endometrial_abnormal_bleeding':
        inputs.endometrialAbnormalBleeding = castEnum(s.value, ENDOMETRIAL_BLEEDING);
        break;
      case 'dexa_screening':
        inputs.dexaScreening = castEnum(s.value, DEXA_SCREENINGS);
        break;
      case 'dexa_last_date':
        inputs.dexaLastDate = screeningDate(s.value, now);
        break;
      case 'dexa_result':
        inputs.dexaResult = castEnum(s.value, DEXA_RESULTS);
        break;
      case 'dexa_followup_status':
        inputs.dexaFollowupStatus = castEnum(s.value, FOLLOWUP_STATUSES);
        break;
      case 'dexa_followup_date':
        inputs.dexaFollowupDate = screeningDate(s.value);
        break;
    }
  }
  return inputs;
}

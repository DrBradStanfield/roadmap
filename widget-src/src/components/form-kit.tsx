// The form's shared helpers and state: what InputPanel hands each of its
// sections (screening first; more to follow as InputPanel splits).
import type { Dispatch, SetStateAction } from 'react';
import { openHistoryLightbox } from '../lib/roadmap-data';
import { describedBy } from '../lib/aria';
import type { useRangeWait } from '../lib/useRangeWait';
import type { HealthInputs } from '@roadmap/health-core/types';
import type { UnitSystem } from '@roadmap/health-core/units';
import { optionsShowing, type FormOption } from '@roadmap/health-core/input-form';

/** Every surface opens metric history in the local lightbox. */
export const interceptHistory = (metric: string) => (e: React.MouseEvent<HTMLAnchorElement>) => {
  if (openHistoryLightbox(metric)) e.preventDefault();
};

/** Focuses an element by id on the next frame, once React has drawn it. */
export const focusById = (id: string) => requestAnimationFrame(() => document.getElementById(id)?.focus());

/** A box's aria-invalid and aria-describedby while any of `errors` is shown as the text with id `errorId`,
 *  as the matrices' cells do (US-02 AC5a); `also` describes it either way. */
export function errorAria(errorId: string, errors: unknown[], also?: string) {
  const shown = errors.some(Boolean);
  return { 'aria-invalid': shown || undefined, 'aria-describedby': describedBy(also, shown && errorId) };
}

/** Option data (health-core's input-form) as <option> elements. */
export const optionElements = (options: FormOption[]) =>
  options.map(opt => <option key={opt.value} value={opt.value} disabled={opt.disabled}>{opt.label}</option>);

/** The key of a recorded answer the list has no option for: never the answer's own text (US-09 AC7l). */
const OFF_LIST = 'recorded-off-list';

/**
 * A select showing what the record holds (health-core's optionsShowing): its value, its change
 * and its options. An answer off the list shows as its "Other (recorded)" option under a fixed
 * key, and picking that key writes nothing, since it is what the record already holds.
 */
export function recordedChoice(listed: ReadonlyArray<{ value: string; label: string }>, recorded: string, pick: (value: string) => void, unrecorded?: string) {
  const offList = recorded !== '' && !listed.some(opt => opt.value === recorded);
  const key = (value: string) => (offList && value === recorded ? OFF_LIST : value);
  return {
    value: key(recorded),
    onChange: (e: React.ChangeEvent<HTMLSelectElement>) => { if (e.target.value !== OFF_LIST) pick(e.target.value); },
    children: optionsShowing(listed, recorded, unrecorded).map(opt => <option key={opt.value} value={key(opt.value)} disabled={opt.disabled}>{opt.label}</option>),
  };
}

export interface FormKit {
  inputs: Partial<HealthInputs>;
  /** Text typed into a box, by field, while it is being typed. */
  rawInputs: Record<string, string>;
  setRawInputs: Dispatch<SetStateAction<Record<string, string>>>;
  /** Field errors, less any range error held back while typing (US-02 AC9). */
  errors: Record<string, string>;
  /** One field's new value; `unit`: the unit a weight or waist was typed in. */
  updateField: <K extends keyof HealthInputs>(field: K, value: HealthInputs[K] | undefined, unit?: UnitSystem) => void;
  /** Records whether the box can be read; false means leave the saved value alone. */
  readable: (field: string, e: React.ChangeEvent<HTMLInputElement>) => boolean;
  /** Boxes holding text the browser could not read (US-02 AC7). */
  unreadable: Record<string, boolean>;
  /** A field's allowed range, in the unit it shows. */
  range: (field: string) => { min: number; max: number };
  /** Tells the range wait what was typed, so a range error may wait (US-02 AC9). */
  typeIn: (field: string, raw: string) => void;
  blurOnWheel: (e: React.WheelEvent<HTMLInputElement>) => void;
  /** Enter shows a held range error. */
  settleOnEnter: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  /** Whether the record has loaded, so a blur or Enter may auto-save. */
  autoSaveGate: boolean;
  rangeWait: ReturnType<typeof useRangeWait>;
}

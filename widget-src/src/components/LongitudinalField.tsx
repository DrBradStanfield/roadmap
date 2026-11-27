// The onboarding's weight box (US-62 AC13), beside the height. Split from
// InputPanel.tsx (W1-2, US-64).
import type { HealthInputs } from '@roadmap/health-core/types';
import { FIELD_METRIC_MAP, type ApiMeasurement, type FormStage } from '@roadmap/health-core/mappings';
import { type UnitSystem, getDisplayLabel, hasUnitChoice } from '@roadmap/health-core/units';
import { parseLocalisedNumber } from '@roadmap/health-core/parseNumber';
import { dayOf, localDay } from '@roadmap/health-core/merge';
import { blockBadNumericKeys } from '../lib/blood-test-cell';
import { formatShortDate } from '../lib/constants';
import type { useAutoAdvance } from '../lib/useAutoAdvance';
import type { FieldUnitToggle } from '../lib/useBloodDraftUnits';
import type { PanelOnboarding } from '../hooks/useOnboarding';
import { CommitTickButton } from './CommitTickButton';
import { previousReference, WEIGHT_STILL_COUNTS_ID } from './WeightStillCounts';
import { errorAria, type FormKit } from './form-kit';
import { inPsaRow } from './ScreeningQuestions';

interface FieldConfig {
  field: keyof HealthInputs;
  name: string;
}

export const WEIGHT_FIELD: FieldConfig = { field: 'weightKg', name: 'Weight' };

/** A box the page moves the focus out of as the tab closes, since a closing
 *  tab fires no blur: the PSA row (US-06 AC15) or the weight box (AC15a). */
export const leftOnClose = (el: Element): boolean => inPsaRow(el) || el.id === WEIGHT_FIELD.field;

/** Whether a field has different SI/conventional labels (i.e., a toggle is useful). */
const hasUnitToggle = (field: string): boolean => {
  const metric = FIELD_METRIC_MAP[field];
  return !!metric && hasUnitChoice(metric);
};

interface LongitudinalFieldProps {
  config: FieldConfig;
  form: FormKit;
  savedOf: (field: string) => { previous: ApiMeasurement | undefined; shown: string };
  formStage: FormStage;
  onToggleFieldUnit: FieldUnitToggle;
  fieldUnit: (field: string) => UnitSystem;
  weightRef: (el: HTMLInputElement | null) => void;
  toDisplay: (field: string, siValue: number | undefined) => string;
  parseAndConvert: (field: string, value: string) => number | undefined;
  rested: PanelOnboarding['rested'];
  answered: PanelOnboarding['answered'];
  advanceToMyHealth: ReturnType<typeof useAutoAdvance>;
  hasApiResponse: boolean;
  scheduleLongitudinalSave: () => void;
  flushLongitudinalSave: () => void;
}

/** The onboarding's weight (US-62 AC13), a plain box like the height's
 *  beside it, holding the saved value; a number typed over it saves through
 *  the same path (one active row per day, US-03 AC3). */
export function LongitudinalField({
  config, form, savedOf, formStage, onToggleFieldUnit, fieldUnit, weightRef, toDisplay, parseAndConvert,
  rested, answered, advanceToMyHealth, hasApiResponse, scheduleLongitudinalSave, flushLongitudinalSave,
}: LongitudinalFieldProps) {
  const { inputs, rawInputs, setRawInputs, errors, updateField, readable, unreadable, range, typeIn, blurOnWheel, settleOnEnter, rangeWait } = form;
  // Shared keydown combo: numeric-only guard (US-02 AC4) + Enter-to-save.
  const onNumericEnter = (e: React.KeyboardEvent<HTMLInputElement>) => { blockBadNumericKeys(e); settleOnEnter(e); autoSaveOnEnterKey(e); };

  // Shared blur/Enter auto-save handlers for every longitudinal input. Each
  // site does its own pre-work (raw-input cleanup) inline, then calls
  // autoSaveOnBlur(); onKeyDown is uniform. Enter also shows a held range error.
  const autoSaveOnBlur = () => { if (hasApiResponse) scheduleLongitudinalSave(); };
  const autoSaveOnEnterKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (hasApiResponse) flushLongitudinalSave();
  };

  const { field, name } = config;
  const r = range(field);
  const { previous, shown } = savedOf(field);
  const needsAttention = field === 'weightKg' && formStage === 1 && inputs.heightCm !== undefined && inputs.weightKg === undefined;
  return (
    <div className={`health-field${needsAttention ? ' field-attention' : ''}`} key={field}>
      <label htmlFor={field}>
        {name}{' '}
        {hasUnitToggle(field) ? (
          <button
            type="button"
            className="unit-toggle-pill" data-unit-control
            onClick={(e) => { e.preventDefault(); onToggleFieldUnit(field); }}
            title={`Switch to ${fieldUnit(field) === 'si' ? 'conventional' : 'metric'} units`}
          >
            {getDisplayLabel(FIELD_METRIC_MAP[field]!, fieldUnit(field))}
          </button>
        ) : (
          FIELD_METRIC_MAP[field] ? <span>({getDisplayLabel(FIELD_METRIC_MAP[field]!, fieldUnit(field))})</span> : null
        )}
      </label>
      <div className="longitudinal-input-row">
        <input
          type="number"
          id={field} ref={field === 'weightKg' ? weightRef : undefined}
          onWheel={blurOnWheel} {...errorAria(`${field}-error`, [unreadable[field], errors[field]], previous && rawInputs[field] === '' ? WEIGHT_STILL_COUNTS_ID : undefined)}
          value={rawInputs[field] !== undefined ? rawInputs[field] : toDisplay(field, (inputs[field] as number | undefined) ?? previous?.value)}
          onChange={(e) => {
            const raw = e.target.value;
            typeIn(field, raw);
            setRawInputs(prev => ({ ...prev, [field]: raw }));
            // The weight at rest once complete, for the landing (US-62 AC25b); anything else cancels the wait.
            const n = parseLocalisedNumber(raw);
            const complete = n !== undefined && /^\d{2,3}$/.test(raw) && n >= r.min && n <= r.max;
            if (field === 'weightKg' && rested) advanceToMyHealth(complete ? { ambiguous: /^\d{2}$/.test(raw) && n * 10 <= r.max, advance: rested } : null);
            if (!readable(field, e)) return;
            // Ignore browser auto-fill of 0 for empty fields (spinner click on empty input)
            if (raw === '0' && inputs[field] === undefined && rawInputs[field] === undefined) {
              return;
            }
            updateField(field, parseAndConvert(field, raw), fieldUnit(field));
            if (field === 'weightKg') answered?.('weightKg');
          }}
          onBlur={() => {
            rangeWait.settle();
            if (unreadable[field]) return;
            // A saved weight cleared stays cleared when left (US-62 AC38).
            if (!previous || rawInputs[field] !== '') setRawInputs(prev => { const next = { ...prev }; delete next[field]; return next; });
            autoSaveOnBlur();
          }}
          onKeyDown={onNumericEnter}
          placeholder=""
          min={r.min}
          max={r.max}
          className={errors[field] ? 'error' : ''}
        />
        {hasApiResponse && inputs[field] !== undefined && (
          <CommitTickButton ariaLabel={`Save ${field}`} onClick={flushLongitudinalSave}/>
        )}
      </div>
      {previous && inputs[field] !== undefined && (
        <span className="previous-reference">{previousReference(shown, previous.recordedAt)}</span>
      )}
      {/* The box shows a saved value of any age: say when it was saved, unless today. */}
      {previous && inputs[field] === undefined && rawInputs[field] === undefined && dayOf(previous.recordedAt) !== localDay(new Date()) && (
        <span className="previous-reference">Saved {formatShortDate(previous.recordedAt)}</span>
      )}
      {(unreadable[field] || errors[field]) && (
        <span className="error-message" id={`${field}-error`}>{unreadable[field] ? 'Enter a number' : errors[field]}</span>
      )}
    </div>
  );
}

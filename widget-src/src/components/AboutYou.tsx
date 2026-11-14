// About you's fields, height, sex, birth date and alcohol, and its rows (moved out of InputPanel).
import { flushSync } from 'react-dom';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { focusById, type FormKit } from './form-kit';
import { ALCOHOL_OPTIONS } from './AlcoholQuestion';
import { MONTHS_FULL } from '../lib/constants';
import { blockBadNumericKeys, blockNonIntegerKeys } from '../lib/blood-test-cell';
import type { useAutoAdvance } from '../lib/useAutoAdvance';
import { SEXES } from '@roadmap/health-core/types';
import { FIELD_METRIC_MAP } from '@roadmap/health-core/mappings';
import { type UnitSystem, getDisplayRange, cmToFeetInches, feetInchesToCm, formatHeightDisplay } from '@roadmap/health-core/units';
import { identityFieldRange, isBirthYearClearlyInvalid } from '@roadmap/health-core/validation';
import { parseLocalisedNumber } from '@roadmap/health-core/parseNumber';
import { useLeaveField } from '../hooks/useOnboarding';

/** About you's rows (US-62 AC12). */
type AboutKey = 'height' | 'sex' | 'birth' | 'alcohol';

/** A height for the feet and inches boxes to show: one there is, and not the
 *  one they just wrote themselves (US-02 AC11). */
function showsOtherHeight(heightCm: number | undefined, typed: number | undefined): heightCm is number {
  return heightCm !== undefined && heightCm !== typed;
}

/** Feet/inches state for US height input. InputPanel owns it, so what was
 *  typed outlives the Height row closing and the onboarding's boxes turning
 *  into rows (US-02 AC11). */
export function useHeightPair(heightCm: number | undefined, unitSystem: UnitSystem) {
  const [heightFeet, setHeightFeet] = useState<string>('');
  const [heightInches, setHeightInches] = useState<string>('');
  // The height the feet and inches boxes last wrote (US-02 AC11).
  const typedHeightCm = useRef<number | undefined>(undefined);

  // Sync heightCm → feet/inches display when loading data or switching units,
  // never from the boxes' own edit, which keeps what was typed (US-02 AC11).
  useEffect(() => {
    if (unitSystem === 'conventional' && showsOtherHeight(heightCm, typedHeightCm.current)) {
      const { feet, inches } = cmToFeetInches(heightCm);
      setHeightFeet(String(feet));
      setHeightInches(String(inches));
    } else if (unitSystem === 'si') {
      // Clear feet/inches when switching to SI
      typedHeightCm.current = undefined;
      setHeightFeet('');
      setHeightInches('');
    }
  }, [heightCm, unitSystem]);

  return { heightFeet, setHeightFeet, heightInches, setHeightInches, typedHeightCm };
}

type HeightPair = ReturnType<typeof useHeightPair>;

// Imperial height, feet then inches: could some inches still bring it in range ("1" may be 10 or 11)?
const heightMayFit = (feet: string, inches: string, inFeet: boolean) => {
  const { min, max } = getDisplayRange(FIELD_METRIC_MAP.heightCm!, 'si');
  const choices = inFeet || inches === '' ? [...Array(12).keys()] : inches === '1' ? [1, 10, 11] : [parseInt(inches, 10) || 0];
  return choices.some(i => { const cm = feetInchesToCm(parseInt(feet, 10) || 0, i); return cm >= min && cm <= max; });
};

export function SexField(props: { form: FormKit; aboutYouLow: boolean }) {
  const { form: { inputs, updateField, errors }, aboutYouLow } = props;
  return (
    <div className={`health-field${!inputs.sex ? ' field-attention' : ''}`}>
      <label>Sex</label>
      <div className="sex-toggle" role="radiogroup" aria-label="Sex">
        {SEXES.map(sex => (
          <button
            key={sex}
            type="button"
            role="radio"
            aria-checked={inputs.sex === sex}
            className={`sex-toggle-btn${inputs.sex === sex ? ' sex-toggle-btn--active' : ''}`}
            onClick={() => { updateField('sex', sex); if (!inputs.birthMonth) focusById('birthMonth'); }}
          >
            {sex === 'male' ? 'Male' : 'Female'}
          </button>
        ))}
      </div>
      {/* Brad 2026-11-02: the why-line asks; once answered it goes. About you's
          Sex row keeps it: someone opening it is reconsidering. */}
      {(!inputs.sex || aboutYouLow) && <p className="field-why">Used to calculate ideal body weight, kidney function, and screening programs.</p>}
      {errors.sex && <span className="error-message">{errors.sex}</span>}
    </div>
  );
}

interface HeightFieldProps {
  form: FormKit;
  pair: HeightPair;
  unitSystem: UnitSystem;
  toDisplay: (field: string, siValue: number | undefined) => string;
  parseAndConvert: (field: string, value: string) => number | undefined;
  /** No weight typed or saved yet: a complete height moves on to the weight. */
  mayAdvanceToWeight: boolean;
  advanceToWeight: ReturnType<typeof useAutoAdvance>;
}

export function HeightField(props: HeightFieldProps) {
  const { form, pair, unitSystem, toDisplay, parseAndConvert, mayAdvanceToWeight, advanceToWeight } = props;
  const { inputs, rawInputs, setRawInputs, errors, updateField, readable, unreadable, range, typeIn, blurOnWheel, settleOnEnter, rangeWait } = form;
  const { heightFeet, setHeightFeet, heightInches, setHeightInches, typedHeightCm } = pair;
  // The feet box hands on to the inches box: only leaving the pair shows the error (Codex R2).
  const leaveHeightPair = (e: React.FocusEvent<HTMLInputElement>) => {
    if (!['heightFeet', 'heightInches'].includes((e.relatedTarget as HTMLElement | null)?.id ?? '')) rangeWait.settle();
  };
  return (
    <div className={`health-field${!inputs.heightCm ? ' field-attention' : ''}`}>
      <label htmlFor="heightCm">
        Height{' '}
        <button
          type="button"
          className="unit-toggle-pill"
          data-unit-control="all"
          onClick={(e) => e.preventDefault()} // the label's own click would focus the box; the switch is hooks/useUnits'
          title={`Switch to ${unitSystem === 'si' ? 'US (in, lbs, mg/dL)' : 'Metric (cm, kg, mmol/L)'}`}
        >
          {unitSystem === 'si' ? 'cm' : 'ft/in'}
        </button>
      </label>
      {unitSystem === 'si' ? (
        <input
          type="number"
          id="heightCm"
          onKeyDown={e => { blockBadNumericKeys(e); settleOnEnter(e); }}
          onWheel={blurOnWheel}
          value={rawInputs['heightCm'] !== undefined ? rawInputs['heightCm'] : toDisplay('heightCm', inputs.heightCm)}
          onChange={(e) => {
            const raw = e.target.value;
            setRawInputs(prev => ({ ...prev, heightCm: raw }));
            if (!readable('heightCm', e)) return;
            typeIn('heightCm', raw);
            updateField('heightCm', parseAndConvert('heightCm', raw));
            const heightNum = parseLocalisedNumber(raw);
            const heightRange = range('heightCm');
            // Plausible height → move on to weight.
            if (heightNum !== undefined && /^\d{2,3}$/.test(raw) && heightNum >= heightRange.min && heightNum <= heightRange.max && mayAdvanceToWeight) {
              advanceToWeight({
                ambiguous: /^\d{2}$/.test(raw) && heightNum * 10 <= heightRange.max,
                advance: () => focusById('weightKg'),
              });
            }
          }}
          onBlur={() => { rangeWait.settle(); if (!unreadable.heightCm) setRawInputs(prev => { const next = { ...prev }; delete next['heightCm']; return next; }); }}
          placeholder=""
          min={range('heightCm').min}
          max={range('heightCm').max}
          className={errors.heightCm ? 'error' : ''}
        />
      ) : (
        <div className="height-fieldset">
          <input
            type="text"
            id="heightFeet"
            aria-label="Height, feet"
            inputMode="numeric"
            pattern="[0-9]*"
            value={heightFeet}
            onChange={(e) => {
              const val = e.target.value.replace(/[^0-9]/g, '');
              setHeightFeet(val);
              rangeWait.typed('heightCm', `${val}/${heightInches}`, heightMayFit(val, heightInches, true));
              const feet = parseInt(val, 10) || 0;
              const inches = parseInt(heightInches, 10) || 0;
              if (val !== '' || heightInches !== '') {
                typedHeightCm.current = feetInchesToCm(feet, inches);
                updateField('heightCm', typedHeightCm.current);
              } else {
                updateField('heightCm', undefined);
              }
              advanceToWeight(null); // a feet edit cancels the inches wait (US-02 AC6c)
              if (val.length === 1) {
                focusById('heightInches');
              }
            }}
            placeholder=""
            maxLength={1}
            onBlur={leaveHeightPair}
            onKeyDown={settleOnEnter}
            className={errors.heightCm ? 'error' : ''}
          />
          <span className="height-unit">ft</span>
          <input
            type="text"
            id="heightInches"
            aria-label="Height, inches"
            inputMode="numeric"
            pattern="[0-9]*"
            value={heightInches}
            onChange={(e) => {
              const val = e.target.value.replace(/[^0-9]/g, '');
              setHeightInches(val);
              rangeWait.typed('heightCm', `${heightFeet}/${val}`, heightMayFit(heightFeet, val, false));
              const feet = parseInt(heightFeet, 10) || 0;
              const inches = parseInt(val, 10) || 0;
              if (heightFeet !== '' || val !== '') {
                typedHeightCm.current = feetInchesToCm(feet, inches);
                updateField('heightCm', typedHeightCm.current);
              } else {
                updateField('heightCm', undefined);
              }
              // Height complete → move on to weight (mirrors the cm
              // path). A lone '1' might still become 10/11, so wait it out;
              // anything else cancels the wait (US-02 AC6c).
              advanceToWeight(heightFeet !== '' && val !== '' && inches <= 11 && mayAdvanceToWeight ? {
                ambiguous: val === '1',
                advance: () => focusById('weightKg'),
              } : null);
            }}
            placeholder=""
            maxLength={2}
            onBlur={leaveHeightPair}
            onKeyDown={settleOnEnter}
            className={errors.heightCm ? 'error' : ''}
          />
          <span className="height-unit">in</span>
        </div>
      )}
      {((unreadable.heightCm && unitSystem === 'si') || errors.heightCm) && (
        <span className="error-message">{unreadable.heightCm && unitSystem === 'si' ? 'Enter a number' : errors.heightCm}</span>
      )}
    </div>
  );
}

// US-60 AC4: the answer the plan's "Reduce alcohol intake" Dismiss asks for,
// in About you's rows only, never during onboarding (Brad 2026-11-02). Tapping
// the chosen answer clears it (M2: the card comes back), so these are pressed
// toggle buttons, not radios (a checked radio cannot uncheck).
export function AlcoholField(props: { form: FormKit }) {
  const { form: { inputs, updateField } } = props;
  return (
    <div className="health-field">
      <label>Alcohol</label>
      <div id="alcohol" className="sex-toggle" role="group" aria-label="Alcohol">
        {ALCOHOL_OPTIONS.map(({ value, label }) => (
          <button
            key={value}
            type="button"
            aria-pressed={inputs.alcohol === value}
            className={`sex-toggle-btn${inputs.alcohol === value ? ' sex-toggle-btn--active' : ''}`}
            onClick={() => updateField('alcohol', inputs.alcohol === value ? undefined : value)}
          >
            {label}
          </button>
        ))}
      </div>
      <p className="field-why">Used to decide whether advice on alcohol applies to you.</p>
    </div>
  );
}

interface BirthFieldsProps {
  form: FormKit;
  /** The year's field, once shown, stays while the birth question does (InputPanel keeps it across remounts). */
  yearShown: boolean;
  /** The year typed, left, and complete (the month set): the onboarding's landing (US-62 AC25b). */
  onYearAnswered?: () => void;
  onYearLeft?: () => void;
  onYearComplete?: () => void;
}

export function BirthFields(props: BirthFieldsProps) {
  const { form, yearShown, onYearAnswered, onYearLeft, onYearComplete } = props;
  const yearRef = useLeaveField(onYearLeft);
  /** The birth month was last pressed by a pointer, not a key (US-01 AC6). Set fresh by every gesture. */
  const monthByPointer = useRef(false);
  const { inputs, errors, updateField, typeIn, blurOnWheel, settleOnEnter, rangeWait } = form;
  return (
    <>
      <div className="health-field-group">
        <div className={`health-field${!inputs.birthMonth && !inputs.birthYear ? ' field-attention' : ''}`}>
          <label htmlFor="birthMonth">Birth Month</label>
          <select
            id="birthMonth"
            value={inputs.birthMonth || ''}
            // A pick by touch or mouse moves on; a key never does. Arrowing a closed select fires
            // change on Windows browsers, and the focus must not leave under the keys (WCAG 3.2.2).
            onPointerDown={() => { monthByPointer.current = true; }}
            onKeyDown={() => { monthByPointer.current = false; }}
            onChange={(e) => {
              const month = parseLocalisedNumber(e.target.value);
              if (month === undefined || inputs.birthYear || !monthByPointer.current) { updateField('birthMonth', month); return; }
              // On to the empty year, inside the change event itself: iOS Safari opens the keyboard
              // only for a focus made in the user's own event, never one a frame later (US-01 AC6).
              flushSync(() => updateField('birthMonth', month));
              document.getElementById('birthYear')?.focus();
            }}
          >
            <option value="">Month...</option>
            {MONTHS_FULL.map((m, i) => (
              <option key={i + 1} value={i + 1}>{m.label}</option>
            ))}
          </select>
          {/* US-54 AC5b: a birth month in the future, left out of the plan. */}
          {errors.birthMonth && <span className="error-message">{errors.birthMonth}</span>}
          {/* US-02 AC5: a year out of range stays, saying why; the store refuses it. */}
          {errors.birthYear && errors.birthYear !== errors.birthMonth && <span className="error-message">{errors.birthYear}</span>}
        </div>

        {/* Once shown on this record it stays, so clearing a year to retype keeps the field (US-62 AC13). */}
        {yearShown && (
          <div className={`health-field stage-reveal${!inputs.birthYear ? ' field-attention' : ''}`}>
            <label htmlFor="birthYear">Birth Year</label>
            <input
              type="number"
              id="birthYear"
              ref={yearRef}
              onKeyDown={e => { blockNonIntegerKeys(e); settleOnEnter(e); }}
              onWheel={blurOnWheel}
              value={inputs.birthYear || ''}
              onChange={(e) => {
                const num = parseLocalisedNumber(e.target.value);
                if (num !== undefined && isBirthYearClearlyInvalid(num)) return;
                typeIn('birthYear', e.target.value);
                updateField('birthYear', num);
                onYearAnswered?.();
                // Brad 2026-11-02: a complete year in range, the month set, may be the
                // last answer: on to My health's top, out of the card, so About you
                // moves without waiting for a blur (US-62 AC25b). "199" never does.
                const years = identityFieldRange('birthYear')!;
                if (onYearComplete && inputs.birthMonth && num !== undefined && /^\d{4}$/.test(e.target.value) && num >= years.min && num <= years.max) {
                  onYearComplete();
                }
              }}
              onBlur={rangeWait.settle}
              placeholder=""
              min="1900"
              max={new Date().getFullYear()}
            />
          </div>
        )}

      </div>
      <p className="field-why">Used to calculate age-based screening suggestions (cancer, bone density) and kidney function.</p>
    </>
  );
}

interface AboutRowsProps {
  form: FormKit;
  /** Every field error, a held range error too: a refused answer keeps its row open. */
  allErrors: Record<string, string>;
  unitSystem: UnitSystem;
  /** The plan's age, shown beside the birth date (US-06 AC5). */
  planAge: number | undefined;
  /** Each row's editor: the field itself, with its why-line. */
  editors: Record<AboutKey, ReactNode>;
}

/** Low, About you is rows, as on the iPhone (US-62 AC12): label left, value
 *  right, a tap opens the field itself in the row's place. The onboarding's
 *  boxes never turn into rows under someone typing. A missing or refused
 *  answer opens its field, which stays open while it is typed in, until Done.
 *  Mounted only while About you is low (and, on desktop, Settings are open):
 *  unmounting closes every row, so after an erase the next record's rows
 *  start closed, and on desktop a row opened by hand closes with the Settings
 *  sheet (the phone's Settings tab stays mounted, so it keeps it open). */
export function AboutRows(props: AboutRowsProps) {
  const { form: { inputs, unreadable }, allErrors, unitSystem, planAge, editors } = props;
  const [aboutOpen, setAboutOpen] = useState<ReadonlySet<AboutKey>>(new Set());
  const month = inputs.birthMonth ? MONTHS_FULL[inputs.birthMonth - 1]?.label : undefined;
  const rows: Array<{ key: AboutKey; label: string; value: string | null; missing: boolean; editor: ReactNode }> = [
    { key: 'height', label: 'Height', editor: editors.height,
      value: inputs.heightCm != null ? formatHeightDisplay(inputs.heightCm, unitSystem) : null,
      missing: inputs.heightCm == null || !!allErrors.heightCm || !!unreadable.heightCm },
    { key: 'sex', label: 'Sex', editor: editors.sex,
      value: inputs.sex === 'male' ? 'Male' : inputs.sex === 'female' ? 'Female' : null,
      missing: !inputs.sex || !!allErrors.sex },
    { key: 'birth', label: 'Birth', editor: editors.birth,
      // The plan's age beside it, as the old collapsed summary said it (US-06 AC5): none when the plan sets the year aside.
      value: inputs.birthYear ? `${[month, inputs.birthYear].filter(Boolean).join(' ')}${planAge !== undefined ? ` (Age ${planAge})` : ''}` : null,
      missing: !inputs.birthYear || !!allErrors.birthMonth || !!allErrors.birthYear },
    // US-60 AC4: unanswered is an answer here, so it never opens itself.
    { key: 'alcohol', label: 'Alcohol', editor: editors.alcohol, missing: false,
      value: ALCOHOL_OPTIONS.find(o => o.value === inputs.alcohol)?.label ?? 'Not answered' },
  ];
  const open = (key: AboutKey) => {
    setAboutOpen(prev => new Set(prev).add(key));
    // The row's own field, never the unit pill beside its label (adversary R5).
    requestAnimationFrame(() => {
      const row = document.querySelector(`[data-about="${key}"]`);
      (row?.querySelector<HTMLElement>('input, select, [role="radio"]') ?? row?.querySelector<HTMLElement>('button'))?.focus();
    });
  };
  const done = (key: AboutKey) => {
    setAboutOpen(prev => { const next = new Set(prev); next.delete(key); return next; });
    focusById(`about-${key}`);
  };
  // A missing or refused answer's row opens and stays open while it is
  // typed in, until Done (one set, updated as it renders).
  // The render-phase setAboutOpen sets this component's own state, which
  // React allows: it renders again at once, before any child sees the old set.
  const opened = rows.filter(row => row.missing && !aboutOpen.has(row.key)).map(row => row.key);
  if (opened.length > 0) setAboutOpen(prev => new Set([...prev, ...opened]));
  return (
    <ul className="md-rows about-rows">
      {rows.map(row => {
        return (
          <li key={row.key}>
            {aboutOpen.has(row.key) || row.missing ? (
              <div className="about-editor" data-about={row.key}>
                {row.editor}
                <button type="button" className="md-back about-done" onClick={() => done(row.key)}>Done</button>
              </div>
            ) : (
              <button type="button" id={`about-${row.key}`} className="about-row" onClick={() => open(row.key)}>
                <span className="about-row-label">{row.label}</span>
                {row.value ? <span className="about-row-value">{row.value}</span> : <span className="md-row-add">Add</span>}
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

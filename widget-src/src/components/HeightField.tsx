// The height field: a cm box, or a feet and inches pair in US units, with the
// unit pill in its label. One field for the full app's About you (HeightField,
// on the form's state) and the single-topic widgets (HeightBoxes, on their own
// state), so a fix to the boxes lands in both (US-74, Brad 2026-11-18). Its
// styles are fields.css, which both bundles carry.
import { useEffect, useRef, useState } from 'react';
import { focusById, type FormKit } from './form-kit';
import { blockBadNumericKeys } from '../lib/blood-test-cell';
import type { useAutoAdvance } from '../lib/useAutoAdvance';
import { FIELD_METRIC_MAP } from '@roadmap/health-core/mappings';
import { type UnitSystem, getDisplayRange, cmToFeetInches, feetInchesToCm } from '@roadmap/health-core/units';
import { parseLocalisedNumber } from '@roadmap/health-core/parseNumber';

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

/** The boxes' ids: the full app's own, or a widget block's, so two blocks never share one (US-74 review U1). */
export interface HeightIds { cm: string; feet: string; inches: string }
const APP_IDS: HeightIds = { cm: 'heightCm', feet: 'heightFeet', inches: 'heightInches' };

/** Feet and inches take digits only, as typed (US-02 AC4). */
const digits = (text: string) => text.replace(/[^0-9]/g, '');

export interface HeightBoxesProps {
  unitSystem: UnitSystem;
  ids?: HeightIds;
  /** Unanswered: the field asks for attention. */
  attention: boolean;
  /** The line under the boxes, if any. */
  error?: string;
  /** Marks the boxes as at fault (their `error` class). */
  invalid: boolean;
  /** The cm box's text and range, metric only. */
  cm: string;
  range: { min: number; max: number };
  onCm: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onCmBlur: () => void;
  /** The feet and inches boxes' digits, US only. */
  feet: string;
  inches: string;
  onFeet: (value: string) => void;
  onInches: (value: string) => void;
  /** The focus left the pair, not one box for the other (Codex R2). */
  onPairLeave: () => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  /** The unit pill in the label; false where the host has its own units control (the widget's Metric/US switch). */
  pill?: boolean;
}

/** The height field's markup and keys, on whoever's state. */
export function HeightBoxes(props: HeightBoxesProps) {
  const { unitSystem, ids = APP_IDS, attention, error, invalid, cm, range, onCm, onCmBlur, feet, inches, onFeet, onInches, onPairLeave, onKeyDown, pill = true } = props;
  const errorId = `${ids.cm}-error`;
  const labelId = `${ids.cm}-label`;
  const className = invalid ? 'error' : '';
  const described = error ? errorId : undefined;
  const leavePair = (e: React.FocusEvent<HTMLInputElement>) => {
    if (![ids.feet, ids.inches].includes((e.relatedTarget as HTMLElement | null)?.id ?? '')) onPairLeave();
  };
  return (
    <div className={`health-field${attention ? ' field-attention' : ''}`}>
      <label id={labelId} htmlFor={ids.cm}>
        Height{pill && ' '}
        {pill && <button
          type="button"
          className="unit-toggle-pill"
          data-unit-control="all"
          onClick={(e) => e.preventDefault()} // the label's own click would focus the box; the switch is hooks/useUnits'
          title={`Switch to ${unitSystem === 'si' ? 'US (in, lbs, mg/dL)' : 'Metric (cm, kg, mmol/L)'}`}
        >
          {unitSystem === 'si' ? 'cm' : 'ft/in'}
        </button>}
      </label>
      {unitSystem === 'si' ? (
        <input
          type="number"
          id={ids.cm}
          onKeyDown={e => { blockBadNumericKeys(e); onKeyDown(e); }}
          onWheel={e => e.currentTarget.blur()}
          value={cm}
          onChange={onCm}
          onBlur={onCmBlur}
          placeholder=""
          min={range.min}
          max={range.max}
          aria-invalid={!!error || undefined}
          aria-describedby={described}
          className={className}
        />
      ) : (
        <div className="height-fieldset" role="group" aria-labelledby={labelId}>
          <input
            type="text"
            id={ids.feet}
            aria-label="Feet"
            inputMode="numeric"
            pattern="[0-9]*"
            value={feet}
            onChange={(e) => {
              const val = digits(e.target.value);
              onFeet(val);
              if (val.length === 1) focusById(ids.inches);
            }}
            placeholder=""
            maxLength={1}
            onBlur={leavePair}
            onKeyDown={onKeyDown}
            aria-invalid={!!error || undefined}
            aria-describedby={described}
            className={className}
          />
          <span className="height-unit">ft</span>
          <input
            type="text"
            id={ids.inches}
            aria-label="Inches"
            inputMode="numeric"
            pattern="[0-9]*"
            value={inches}
            onChange={(e) => onInches(digits(e.target.value))}
            placeholder=""
            maxLength={2}
            onBlur={leavePair}
            onKeyDown={onKeyDown}
            aria-invalid={!!error || undefined}
            aria-describedby={described}
            className={className}
          />
          <span className="height-unit">in</span>
        </div>
      )}
      {error && <span id={errorId} className="error-message">{error}</span>}
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

/** About you's height, on the form's state. */
export function HeightField(props: HeightFieldProps) {
  const { form, pair, unitSystem, toDisplay, parseAndConvert, mayAdvanceToWeight, advanceToWeight } = props;
  const { inputs, rawInputs, setRawInputs, errors, updateField, readable, unreadable, range, typeIn, settleOnEnter, rangeWait } = form;
  const { heightFeet, setHeightFeet, heightInches, setHeightInches, typedHeightCm } = pair;
  return (
    <HeightBoxes
      unitSystem={unitSystem}
      attention={!inputs.heightCm}
      error={unreadable.heightCm && unitSystem === 'si' ? 'Enter a number' : errors.heightCm}
      invalid={!!errors.heightCm}
      cm={rawInputs['heightCm'] !== undefined ? rawInputs['heightCm'] : toDisplay('heightCm', inputs.heightCm)}
      range={range('heightCm')}
      onCm={(e) => {
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
      onCmBlur={() => { rangeWait.settle(); if (!unreadable.heightCm) setRawInputs(prev => { const next = { ...prev }; delete next['heightCm']; return next; }); }}
      feet={heightFeet}
      inches={heightInches}
      onFeet={(val) => {
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
      }}
      onInches={(val) => {
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
      onPairLeave={rangeWait.settle}
      onKeyDown={settleOnEnter}
    />
  );
}

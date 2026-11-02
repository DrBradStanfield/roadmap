// US-21 phase 2 — manual "+ Add a blood test" beneath the additional-lab
// groups. Catalogue tests save under their STABLE key with the canonical
// unit fixed (AC3/AC4); "Other" takes a free-form name + unit. Store-side
// dedup (one active value per test per day) is surfaced, not silent, and the
// value already there can be replaced: a correction through the same door as
// the cell editor, never a second row (AC13). A core test's name writes its
// core value (US-66 AC6), so a held day finds the core row and a refused
// number reads as the matrix says it.

import { useEffect, useState, type MutableRefObject } from 'react';
import { canonicalToReported, commaQuestion, displayLabUnit, formatLabValue, LAB_CATALOG, LAB_GROUPS, localDay, parseLocalisedNumber, reportedToCanonical, savedLabText, slotKey, type ApiMeasurement, type Comparator } from '@roadmap/health-core';
import { bloodTestKeyOf, coreStored } from '@roadmap/health-core/blood-tests';
import { UnitChip } from './UnitChip';
import { SAVE_ERRORS } from './BloodTestTimeline';
import { bulkSaveLabValues } from '../lib/roadmap-data';
import { trackProductEvent } from '../lib/server-api';
import { rangeMessage, sameAsSaved } from '../lib/blood-test-cell';
import { labUnitRefusalLine } from '../lib/lab-value-labels';
import type { CorrectFn } from '../lib/matrix-save';
import type { ApiLabValue } from '../lib/api-types';

/** A saved value the form names: `value` in the unit typed, `stored` in the unit the row keeps. */
interface Held { id: string; slot: string; value: number; unit: string; stored: number; comparator?: Comparator }

export function AddLabTest({ onAdded, labValues = [], coreValues = [], onCorrect, preset, dirtyRef }: {
  onAdded: () => void;
  /** The saved values, to name the one a duplicate collides with. */
  labValues?: ApiLabValue[];
  /** The saved core blood values, which a core test's name collides with (US-66 AC6). */
  coreValues?: ApiMeasurement[];
  /** The cell editor's correction: present = Replace is offered. */
  onCorrect?: CorrectFn;
  /** One test, fixed: a phone value page's Add (US-62 AC10). The test is
   *  not chosen, and the form adds a value to it under the same rules. */
  preset?: { metricName: string; unit: string };
  /** Set while the form holds a typed value not yet saved (a value page asks before leaving it). */
  dirtyRef?: MutableRefObject<boolean>;
}) {
  const presetKey = preset && (LAB_CATALOG.some(e => e.key === preset.metricName) ? preset.metricName : 'custom');
  const [open, setOpen] = useState(false);
  const [testKey, setTestKey] = useState(presetKey ?? ''); // catalogue key | 'custom' | ''
  const [customName, setCustomName] = useState(presetKey === 'custom' ? preset!.metricName : '');
  const [customUnit, setCustomUnit] = useState(presetKey === 'custom' ? preset!.unit : '');
  const [valueStr, setValueStr] = useState('');
  const [date, setDate] = useState(() => localDay(new Date()));
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // The saved value a Replace would correct.
  const [held, setHeld] = useState<Held | null>(null);
  if (dirtyRef) dirtyRef.current = open && valueStr.trim() !== '';
  useEffect(() => () => { if (dirtyRef) dirtyRef.current = false; }, []);

  if (!open) {
    return (
      <button type="button" className="alr-add-btn" onClick={() => setOpen(true)}>
        {preset ? '+ Add a value' : '+ Add a blood test'}
      </button>
    );
  }

  const entry = LAB_CATALOG.find(e => e.key === testKey);
  // A catalogued test has no input range, so "1,050" is always asked about (US-02 AC7).
  const value = parseLocalisedNumber(valueStr);
  const question = commaQuestion(valueStr);
  const metricName = entry ? entry.key : customName.trim();
  const unit = entry ? entry.unit : customUnit.trim();
  // As health-core's writer reads the name: a core test's is its core slot, the value converted (US-66 AC6).
  const core = bloodTestKeyOf(metricName);
  const slot = core ? slotKey('measurement', core, date) : slotKey('lab', metricName, date);
  const stored = core && value !== undefined ? coreStored(core, value, unit)?.value : value;
  // parseLocalisedNumber only returns finite numbers or undefined. The date
  // guard also blocks future dates typed past the input's max (ISO strings
  // compare lexicographically).
  const canSave = !saving && !!metricName && !!date && date <= localDay(new Date()) &&
    value !== undefined && value >= 0;

  const clearNotice = () => { setNotice(null); setHeld(null); };
  const close = () => {
    setOpen(false);
    setTestKey(presetKey ?? '');
    setCustomName(presetKey === 'custom' ? preset!.metricName : '');
    setCustomUnit(presetKey === 'custom' ? preset!.unit : '');
    setValueStr('');
    setDate(localDay(new Date())); clearNotice();
  };

  /** A saved value as the form names it: "45 µg/L", "< 5 µg/L" (US-12 AC20). */
  const labelOf = (v: Held) => `${savedLabText(v.value, v.comparator)} ${displayLabUnit(v.unit, entry)}`;
  /** The saved value is the one the form describes: this test, this day, this unit. */
  const describes = (v: Held) => v.slot === slot && displayLabUnit(v.unit, entry) === displayLabUnit(unit, entry);

  /** The value saved in the form's slot: a core value shown in the unit typed. */
  const heldValue = (): Held | undefined => {
    if (!core) {
      const v = labValues.find(v => slotKey('lab', v.metricName, v.recordedAt) === slot);
      return v && { id: v.id, slot, value: v.value, unit: v.unit, stored: v.value, comparator: v.comparator };
    }
    const m = coreValues.find(m => slotKey('measurement', m.metricType, m.recordedAt) === slot);
    const shown = m && canonicalToReported(core, m.value, unit);
    return m && shown != null ? { id: m.id, slot, value: shown, unit, stored: m.value, comparator: m.comparator } : undefined;
  };

  /** The day already holds this test. Name what is there, and offer to
   *  replace it when that changes the number in the same unit. */
  const collided = () => {
    const there = heldValue();
    if (!there) { setNotice('That test already has a value for that date.'); return; }
    setNotice(`That test already has ${labelOf(there)} for that date.`);
    if (onCorrect && describes(there) && !sameAsSaved(value!, formatLabValue(there.value), stored!, there.stored)) setHeld(there);
  };

  // Any change to the form withdraws the offer (clearNotice); Replace still
  // checks, just before it writes, that the form describes the value it names.
  const replace = async (there: Held) => {
    if (!describes(there)) { clearNotice(); return; }
    setSaving(true);
    const status = await onCorrect!(there.id, stored!);
    setSaving(false);
    if (status === 'ok') close();
    else setNotice(SAVE_ERRORS[status]);
  };

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    clearNotice();
    try {
      const result = await bulkSaveLabValues([{
        metricName,
        value: value!,
        unit,
        recordedAt: `${date}T00:00:00.000Z`,
        source: 'manual',
      }]);
      if (result.saved.length > 0) {
        trackProductEvent('lab_row_added');
        close();
        onAdded();
      } else if (result.refused.length > 0) {
        // A catalogued test typed under "Other" can still name a unit the
        // catalogue does not take (US-21 phase 3), or a number it refuses in
        // one it does: say so in the upload summary's words (US-21 AC15).
        setNotice(labUnitRefusalLine(result.refused[0].key, result.refused[0].unit, result.refused[0].fault));
      } else if (result.measurementRefusals?.length) {
        // A core value out of range reads as the matrix says it, in the unit typed (US-66 AC6).
        const { bound } = result.measurementRefusals[0];
        const system = core && reportedToCanonical(core, value!, unit)?.system;
        setNotice(bound && system ? rangeMessage(core, system, bound) : SAVE_ERRORS.invalid);
      } else if (result.skippedDuplicates > 0) {
        collided();
      } else {
        setNotice('Could not save — please try again.');
      }
    } catch {
      setNotice('Could not save — please try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="alr-add-form">
      <div className="alr-add-fields">
        {!preset && <select
          aria-label="Test"
          className="alr-add-select"
          value={testKey}
          onChange={e => { setTestKey(e.target.value); clearNotice(); }}
        >
          <option value="">Choose a test…</option>
          {LAB_GROUPS.map(g => (
            <optgroup key={g.id} label={g.label}>
              {LAB_CATALOG.filter(e => e.group === g.id).map(e => (
                <option key={e.key} value={e.key}>{e.label}</option>
              ))}
            </optgroup>
          ))}
          <option value="custom">Other test…</option>
        </select>}
        {testKey === 'custom' && !preset && (
          <input
            aria-label="Test name"
            className="alr-add-input alr-add-name"
            type="text"
            placeholder="Test name"
            value={customName}
            onChange={e => { setCustomName(e.target.value); clearNotice(); }}
          />
        )}
        <input
          aria-label="Value"
          className="alr-add-input alr-add-value"
          type="text"
          inputMode="decimal"
          placeholder="Value"
          value={valueStr}
          onChange={e => { setValueStr(e.target.value); clearNotice(); }}
        />
        {entry
          ? <UnitChip label={entry.unit} title="Recorded in this unit"/>
          : testKey === 'custom' && (preset ? <UnitChip label={customUnit} title="Recorded in this unit"/> :
              <input
                aria-label="Unit"
                className="alr-add-input alr-add-unit"
                type="text"
                placeholder="Unit"
                value={customUnit}
                onChange={e => { setCustomUnit(e.target.value); clearNotice(); }}
              />
            )}
        <input
          aria-label="Date"
          className="alr-add-input alr-add-date"
          type="date"
          value={date}
          max={localDay(new Date())}
          onChange={e => { setDate(e.target.value); clearNotice(); }}
        />
      </div>
      {(notice ?? question) && <div className="alr-add-notice">{notice ?? question}</div>}
      <div className="alr-add-actions">
        <button type="button" className="alr-add-save" disabled={!canSave}
                onClick={() => void (held ? replace(held) : save())}>
          {held ? `Replace ${labelOf(held)} with ${valueStr}` : 'Save'}
        </button>
        <button type="button" className="alr-add-cancel" onClick={close}>
          Cancel
        </button>
      </div>
    </div>
  );
}

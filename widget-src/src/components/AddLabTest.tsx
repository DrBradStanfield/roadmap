// US-21 phase 2 — manual "+ Add a blood test" beneath the additional-lab
// groups. Catalogue tests save under their STABLE key with the canonical
// unit fixed (AC3/AC4); "Other" takes a free-form name + unit. Store-side
// dedup (one active value per test per day) is surfaced, not silent, and the
// value already there can be replaced: a correction through the same door as
// the cell editor, never a second row (AC13). A core test's name writes its
// core value (US-66 AC6), so a held day finds the core row and a refused
// number reads as the matrix says it.

import { useEffect, useState, type MutableRefObject } from 'react';
import { canonicalToReported, commaQuestion, displayLabUnit, LAB_CATALOG, LAB_GROUPS, labRangeMessage, localDay, parseLocalisedNumber, resolveLabCatalogEntry, savedLabText, slotKey, type ApiMeasurement, type Comparator } from '@roadmap/health-core';
import { bloodTestKeyOf, coreStored } from '@roadmap/health-core/blood-tests';
import { UnitChip } from './UnitChip';
import { SAVE_ERRORS, saveErrorText } from './BloodTestTimeline';
import { addLabValue } from '../lib/roadmap-data';
import { trackProductEvent } from '../lib/server-api';
import type { CorrectFn } from '../lib/matrix-save';
import type { ApiLabValue } from '../lib/api-types';

/** A saved value the form names: `value` in the unit typed, `stored` in the unit the row keeps. */
interface Held { id: string; slot: string; value: number; unit: string; stored: number; comparator?: Comparator }

/** The iPhone's words for the same refusal (ios/engine/my-data.ts addSeriesValue). */
const CORE_ON_LAB_PAGE = 'Add this test from its row in Blood tests.';

/** The name typed under "Other" counts only while Other is chosen: "Choose a test…" names no test, so nothing saves (US-21 AC2). */
const otherName = (testKey: string, customName: string) => (testKey === 'custom' ? customName.trim() : '');

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
  // A catalogued test has no input range, only the record's typing-mistake bounds checked on save
  // (US-21 AC26), so "1,050" is always asked about (US-02 AC7).
  const value = parseLocalisedNumber(valueStr);
  const question = commaQuestion(valueStr);
  const metricName = entry ? entry.key : otherName(testKey, customName);
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

  // The typed test's catalogue entry, as the record's lab add resolves it (addLabValue): an "Other
  // test" the catalogue knows ("Ferritin" in ng/mL) is its catalogue test, in its units.
  const known = entry ?? resolveLabCatalogEntry(metricName);
  /** A saved value as the form names it: "45 µg/L", "< 5 µg/L" (US-12 AC20). */
  const labelOf = (v: Held) => `${savedLabText(v.value, v.comparator)} ${displayLabUnit(v.unit, known)}`;
  /** The saved value is the one the form describes: this test, this day, this unit. */
  const describes = (v: Held) => v.slot === slot && displayLabUnit(v.unit, known) === displayLabUnit(unit, known);

  /** The saved value the record offers to replace: a core value shown in the unit typed. */
  const heldOf = (id: string): Held | undefined => {
    if (!core) {
      const v = labValues.find(v => v.id === id);
      return v && { id, slot, value: v.value, unit: v.unit, stored: v.value, comparator: v.comparator };
    }
    const m = coreValues.find(m => m.id === id);
    const shown = m && canonicalToReported(core, m.value, unit);
    return m && shown != null ? { id, slot, value: shown, unit, stored: m.value, comparator: m.comparator } : undefined;
  };

  // Any change to the form withdraws the offer (clearNotice); Replace still
  // checks, just before it writes, that the form describes the value it names.
  const replace = async (there: Held) => {
    if (!describes(there)) { clearNotice(); return; }
    setSaving(true);
    const status = await onCorrect!(there.id, stored!);
    setSaving(false);
    if (status === 'ok') close();
    else setNotice(saveErrorText(status));
  };

  const save = async () => {
    if (!canSave) return;
    // A value page for a kept-apart row named like a core test (an old "creatinine" may be urine,
    // US-12 AC11): the add would write the core value, which this page never shows (US-66 AC5).
    if (preset && core) { setNotice(CORE_ON_LAB_PAGE); return; }
    setSaving(true);
    clearNotice();
    try {
      // health-core's one lab add (US-25 AC25): it files the test, refuses a unit the catalogue does
      // not take in the upload summary's words (US-21 AC15), and names a held value on that day.
      // A value page adds to its own series, whatever its name or unit (US-25 AC25).
      const result = await addLabValue({ metricName, unit, value: value!, day: date, ...(preset ? { existingSeries: true } : null) });
      if (!result) {
        setNotice('Could not save — please try again.');
      } else if (result.ok) {
        trackProductEvent('lab_row_added');
        close();
        onAdded();
      } else if (result.bound) {
        // A core value out of range reads as the matrix says it, in the unit typed (US-66 AC6).
        setNotice((core && labRangeMessage(core, unit, result.bound)) || SAVE_ERRORS.invalid);
      } else {
        setNotice(result.message);
        // A held value in the same unit holding another number: offer to replace it (US-21 AC13).
        const there = result.existingId ? heldOf(result.existingId) : undefined;
        if (onCorrect && there) setHeld(there);
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

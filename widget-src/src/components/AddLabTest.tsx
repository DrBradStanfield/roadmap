// US-21 phase 2 — manual "+ Add a blood test" beneath the additional-lab
// groups. Catalogue tests save under their STABLE key with the canonical
// unit fixed (AC3/AC4); "Other" takes a free-form name + unit. Store-side
// dedup (one active value per test per day) is surfaced, not silent, and the
// value already there can be replaced: a correction through the same door as
// the cell editor, never a second row (AC13).

import { useState } from 'react';
import { displayLabUnit, LAB_CATALOG, LAB_GROUPS, localDay, parseLocalisedNumber, slotKey } from '@roadmap/health-core';
import { UnitChip } from './UnitChip';
import { SAVE_ERRORS } from './BloodTestTimeline';
import { bulkSaveLabValues } from '../lib/roadmap-data';
import { trackProductEvent } from '../lib/server-api';
import { formatLabValue, sameAsSaved } from '../lib/blood-test-cell';
import type { CorrectFn } from '../lib/matrix-save';
import type { ApiLabValue } from '../lib/api-types';

export function AddLabTest({ onAdded, labValues = [], onCorrect }: {
  onAdded: () => void;
  /** The saved values, to name the one a duplicate collides with. */
  labValues?: ApiLabValue[];
  /** The cell editor's correction: present = Replace is offered. */
  onCorrect?: CorrectFn;
}) {
  const [open, setOpen] = useState(false);
  const [testKey, setTestKey] = useState(''); // catalogue key | 'custom' | ''
  const [customName, setCustomName] = useState('');
  const [customUnit, setCustomUnit] = useState('');
  const [valueStr, setValueStr] = useState('');
  const [date, setDate] = useState(() => localDay(new Date()));
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // The saved value a Replace would correct.
  const [held, setHeld] = useState<ApiLabValue | null>(null);

  if (!open) {
    return (
      <button type="button" className="alr-add-btn" onClick={() => setOpen(true)}>
        + Add a blood test
      </button>
    );
  }

  const entry = LAB_CATALOG.find(e => e.key === testKey);
  const value = parseLocalisedNumber(valueStr);
  const metricName = entry ? entry.key : customName.trim();
  const unit = entry ? entry.unit : customUnit.trim();
  // parseLocalisedNumber only returns finite numbers or undefined. The date
  // guard also blocks future dates typed past the input's max (ISO strings
  // compare lexicographically).
  const canSave = !saving && !!metricName && !!date && date <= localDay(new Date()) &&
    value !== undefined && value >= 0;

  const clearNotice = () => { setNotice(null); setHeld(null); };
  const close = () => {
    setOpen(false);
    setTestKey(''); setCustomName(''); setCustomUnit(''); setValueStr('');
    setDate(localDay(new Date())); clearNotice();
  };

  /** A saved value as the form names it: "45 µg/L". */
  const labelOf = (v: ApiLabValue) => `${formatLabValue(v.value)} ${displayLabUnit(v.unit, entry)}`;
  /** The saved value is the one the form describes: this test, this day, this unit. */
  const describes = (v: ApiLabValue) =>
    slotKey('lab', v.metricName, v.recordedAt) === slotKey('lab', metricName, date) &&
    displayLabUnit(v.unit, entry) === displayLabUnit(unit, entry);

  /** The day already holds this test. Name what is there, and offer to
   *  replace it when that changes the number in the same unit. */
  const collided = () => {
    const slot = slotKey('lab', metricName, date);
    const there = labValues.find(v => slotKey('lab', v.metricName, v.recordedAt) === slot);
    if (!there) { setNotice('That test already has a value for that date.'); return; }
    setNotice(`That test already has ${labelOf(there)} for that date.`);
    if (onCorrect && describes(there) && !sameAsSaved(value!, formatLabValue(there.value), value!, there.value)) setHeld(there);
  };

  // Any change to the form withdraws the offer (clearNotice); Replace still
  // checks, just before it writes, that the form describes the value it names.
  const replace = async (there: ApiLabValue) => {
    if (!describes(there)) { clearNotice(); return; }
    setSaving(true);
    const status = await onCorrect!(there.id, value!);
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
        // catalogue does not take (US-21 phase 3). Say which units reach it.
        setNotice(result.refused[0].message);
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
        <select
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
        </select>
        {testKey === 'custom' && (
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
          : testKey === 'custom' && (
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
      {notice && <div className="alr-add-notice">{notice}</div>}
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

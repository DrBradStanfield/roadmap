// US-21 phase 2 — manual "+ Add a blood test" beneath the additional-lab
// groups. Catalogue tests save under their STABLE key with the canonical
// unit fixed (AC3/AC4); "Other" takes a free-form name + unit. Store-side
// dedup (one active value per test per day) is surfaced, not silent.

import { useState } from 'react';
import { LAB_CATALOG, LAB_GROUPS, parseLocalisedNumber } from '@roadmap/health-core';
import { UnitChip } from './UnitChip';
import { todayIsoLocal } from '../lib/constants';
import { bulkSaveLabValues, trackProductEvent } from '../lib/api';

export function AddLabTest({ onAdded }: { onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [testKey, setTestKey] = useState(''); // catalogue key | 'custom' | ''
  const [customName, setCustomName] = useState('');
  const [customUnit, setCustomUnit] = useState('');
  const [valueStr, setValueStr] = useState('');
  const [date, setDate] = useState(todayIsoLocal);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

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
  // parseLocalisedNumber only returns finite numbers or undefined. The date
  // guard also blocks future dates typed past the input's max (ISO strings
  // compare lexicographically).
  const canSave = !saving && !!metricName && !!date && date <= todayIsoLocal() &&
    value !== undefined && value >= 0;

  const close = () => {
    setOpen(false);
    setTestKey(''); setCustomName(''); setCustomUnit(''); setValueStr('');
    setDate(todayIsoLocal()); setNotice(null);
  };

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    setNotice(null);
    try {
      const result = await bulkSaveLabValues([{
        metricName,
        value: value!,
        unit: entry ? entry.unit : customUnit.trim(),
        recordedAt: `${date}T00:00:00.000Z`,
        source: 'manual',
      }]);
      if (result.saved.length > 0) {
        trackProductEvent('lab_row_added');
        close();
        onAdded();
      } else if (result.skippedDuplicates > 0) {
        setNotice('That test already has a value for that date.');
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
          onChange={e => { setTestKey(e.target.value); setNotice(null); }}
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
            onChange={e => setCustomName(e.target.value)}
          />
        )}
        <input
          aria-label="Value"
          className="alr-add-input alr-add-value"
          type="text"
          inputMode="decimal"
          placeholder="Value"
          value={valueStr}
          onChange={e => { setValueStr(e.target.value); setNotice(null); }}
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
                onChange={e => setCustomUnit(e.target.value)}
              />
            )}
        <input
          aria-label="Date"
          className="alr-add-input alr-add-date"
          type="date"
          value={date}
          max={todayIsoLocal()}
          onChange={e => { setDate(e.target.value); setNotice(null); }}
        />
      </div>
      {notice && <div className="alr-add-notice">{notice}</div>}
      <div className="alr-add-actions">
        <button type="button" className="alr-add-save" disabled={!canSave} onClick={save}>
          Save
        </button>
        <button type="button" className="alr-add-cancel" onClick={close}>
          Cancel
        </button>
      </div>
    </div>
  );
}

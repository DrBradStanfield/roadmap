// US-06 and US-62 AC30c, AC30e: Supplements' own list, each with its dose and
// unit, and "+ Add another supplement", whose search adds a preset or a custom
// name. Split from InputPanel.tsx (2026-11-09) when the touch fix grew it.

import { Fragment, useEffect, useReducer, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { SUPPLEMENT_OPTIONS } from '@roadmap/health-core/types';
import { parseLocalisedNumber } from '@roadmap/health-core/parseNumber';
import { SUPPLEMENT_TEXT, SUPPLEMENT_DOSE_UNITS, customSupplementAdd, customSupplementMatch } from '@roadmap/health-core/input-form';
import { blockBadNumericKeys } from '../lib/blood-test-cell';
import { DRAFTS_CLEARED_EVENT } from '../lib/storage';
import { CLOSED, transition, type SupplementAddEvent } from '../lib/supplement-add';
import type { ApiSupplement } from '../lib/api-types';

export function SupplementsSection({ supplements, onSupplementChange, onSupplementDelete }: {
  supplements: ApiSupplement[];
  onSupplementChange: (key: string, name: string, doseValue: number | null, doseUnit: string | null) => void;
  onSupplementDelete: (key: string) => void;
}) {

const [supplementDoseDrafts, setSupplementDoseDrafts] = useState<Record<string, string | undefined>>({});
// "+ Add another supplement" opens the search in its place (Brad 2026-11-09, as Add a blood test).
// Its mode is one named state (lib/supplement-add.ts); events queue in order, so a blur sees the press before it.
const [add, send] = useReducer(transition, CLOSED);
const addingSupplement = add.phase === 'open';
const showSupplementDropdown = add.phase === 'open' && add.list;
const supplementSearch = add.phase === 'open' ? add.query : '';
const supplementDropdownRef = useRef<HTMLDivElement>(null);
const supplementSearchRef = useRef<HTMLInputElement>(null);
const supplementAddRef = useRef<HTMLButtonElement>(null);
/** This touch's claim: a finger is down on the list and has not scrolled it (a scroll is a pointercancel). */
const supplementTouch = useRef(false);
/** Back to the "+ Add another supplement" row, the focus on it. */
const closeSupplementAdd = (event: Extract<SupplementAddEvent, { type: 'escaped' | 'added' }>) => {
  flushSync(() => send(event));
  supplementAddRef.current?.focus();
};

// An erase clears off-file drafts too, including one under a later reused key.
useEffect(() => {
  const drop = () => setSupplementDoseDrafts({});
  window.addEventListener(DRAFTS_CLEARED_EVENT, drop);
  return () => window.removeEventListener(DRAFTS_CLEARED_EVENT, drop);
}, []);

useEffect(() => {
  if (!showSupplementDropdown) return;
  // On pointerdown, whose target is the element under the finger: a touch's
  // mousedown comes later, where WebKit's tap adjustment puts it (US-62 AC30e).
  const handleClickOutside = (e: PointerEvent) => {
    if (supplementDropdownRef.current && !supplementDropdownRef.current.contains(e.target as Node)) send({ type: 'pressedOutside' });
  };
  document.addEventListener('pointerdown', handleClickOutside);
  return () => document.removeEventListener('pointerdown', handleClickOutside);
}, [showSupplementDropdown]);

  const activeSupplements = supplements.filter(s => s.status === 'active');
  const allOptions = SUPPLEMENT_OPTIONS.filter(
    opt => !activeSupplements.some(s => s.supplementKey === opt.key),
  );
  const filteredOptions = supplementSearch
    ? allOptions.filter(opt => opt.name.toLowerCase().includes(supplementSearch.toLowerCase()))
    : allOptions;
  const trimmedSearch = supplementSearch.trim();
  // A typed name with no exact preset match can always be added as a custom
  // supplement — this must NOT be gated on filteredOptions having matches, or
  // a supplement matching no preset can never be added.
  // A name already taken is hidden too, as a preset is: re-adding it would clear its dose (US-06 AC1a).
  const canAddCustomSupplement = !!trimmedSearch
    && !allOptions.some(o => o.name.toLowerCase() === trimmedSearch.toLowerCase())
    && customSupplementMatch(trimmedSearch, supplements)?.status !== 'active';

  const addSupplement = (key: string, name: string, defaultDose?: number, defaultUnit?: string) => {
    setSupplementDoseDrafts(prev => ({ ...prev, [key]: undefined }));
    onSupplementChange(key, name, defaultDose ?? null, defaultUnit ?? null);
    closeSupplementAdd({ type: 'added' }); // the focus back on the row, not lost to the page (AC30c)
  };
  const addCustomSupplement = () => {
    const { supplementKey, supplementName } = customSupplementAdd(trimmedSearch, supplements);
    addSupplement(supplementKey, supplementName);
  };

  return (
    <div className="section-card">
      <section className="health-section" aria-label={SUPPLEMENT_TEXT.title}>
        {/* Active supplements list */}
        {activeSupplements.map(s => (
          <Fragment key={s.supplementKey}>
            <div className="supplement-row">
              <span className="supplement-name">{s.supplementName}</span>
              <input
                type="number"
                className="supplement-dose"
                placeholder="Dose"
                min={Number.MIN_VALUE}
                max={99999}
                step="any"
                onKeyDown={blockBadNumericKeys}
                value={supplementDoseDrafts[s.supplementKey] ?? s.doseValue ?? ''}
                aria-invalid={supplementDoseDrafts[s.supplementKey] !== undefined || undefined}
                aria-describedby={supplementDoseDrafts[s.supplementKey] !== undefined ? `supplement-dose-error-${s.supplementKey}` : undefined}
                onChange={e => {
                  const raw = e.target.value;
                  const val = raw ? parseLocalisedNumber(raw) ?? null : null;
                  // Autosave bypasses native form validation. Keep invalid drafts
                  // out of the accepted row, including badInput's empty value.
                  const invalid = e.target.validity.badInput || (raw !== '' && (val === null || val <= 0 || val > 99999));
                  setSupplementDoseDrafts(prev => ({ ...prev, [s.supplementKey]: invalid ? raw : undefined }));
                  if (invalid) return;
                  onSupplementChange(s.supplementKey, s.supplementName, val, s.doseUnit);
                }}
              />
              <select
                className="supplement-unit"
                value={s.doseUnit ?? ''}
                onChange={e => onSupplementChange(s.supplementKey, s.supplementName, s.doseValue, e.target.value || null)}
              >
                <option value="">Unit</option>
                {SUPPLEMENT_DOSE_UNITS.map(unit => <option key={unit} value={unit}>{unit}</option>)}
              </select>
              <button
                type="button"
                className="supplement-remove"
                onClick={() => onSupplementDelete(s.supplementKey)}
                title="Remove"
              >
                ×
              </button>
            </div>
            {supplementDoseDrafts[s.supplementKey] !== undefined && (
              <span className="error-message" id={`supplement-dose-error-${s.supplementKey}`} role="alert">Enter a dose greater than 0 and no more than 99999. This dose was not saved.</span>
            )}
          </Fragment>
        ))}

        {/* Add other supplement: a row like Add a blood test, its search behind it. */}
        <div className="supplement-add mh-add-test" ref={supplementDropdownRef} onBlur={e => {
          // Focus leaving the search and its list empty, by Tab or a tap elsewhere: back to the row (#985).
          // Escape in either goes back too, the focus on the row (keydown below).
          // A press in the list blurs it first on an iPhone; closing then moved the next card under the finger (AC30g).
          // Only an empty search with no press held closes (transition).
          if (addingSupplement && !e.currentTarget.contains(e.relatedTarget as Node | null)) flushSync(() => send({ type: 'focusLeft' }));
        }} onKeyDown={e => { if (e.key === 'Escape' && addingSupplement) closeSupplementAdd({ type: 'escaped' }); }}>
          {!addingSupplement ? (
            <button ref={supplementAddRef} type="button" className="alr-add-btn" onClick={() => {
              // Shown and focused inside the tap itself, so a phone opens its keyboard (US-01 AC6).
              flushSync(() => send({ type: 'opened' }));
              supplementSearchRef.current?.focus();
            }}>
              + Add another supplement
            </button>
          ) : (<>
          <input
            ref={supplementSearchRef}
            type="text"
            placeholder={SUPPLEMENT_TEXT.addPlaceholder}
            value={supplementSearch}
            maxLength={100}
            onFocus={() => send({ type: 'focused' })}
            onChange={e => send({ type: 'typed', query: e.target.value })}
            onKeyDown={e => {
              // Return adds the exact match, else the list's first option, else the typed name (AC30e).
              if (e.key !== 'Enter' || e.nativeEvent.isComposing || !trimmedSearch) return;
              e.preventDefault();
              const pick = filteredOptions.find(o => o.name.toLowerCase() === trimmedSearch.toLowerCase()) ?? filteredOptions[0];
              if (pick) addSupplement(pick.key, pick.name, pick.defaultDose, pick.defaultUnit);
              else if (canAddCustomSupplement) addCustomSupplement();
            }}
          />
          {showSupplementDropdown && (filteredOptions.length > 0 || canAddCustomSupplement) && (
            // A press in the list keeps the focus in the search, so its blur never closes it first.
            // A tap chooses from its touchend, whose target is the option under the finger. Its
            // default prevented, no mousedown or click follows to land where WebKit's tap
            // adjustment or the closing keyboard puts it (iPhone: nothing was added, AC30e).
            <div className="supplement-dropdown" onMouseDown={e => e.preventDefault()}
              onPointerDown={e => { supplementTouch.current = e.pointerType === 'touch'; send({ type: 'pressedList' }); }}
              onPointerCancel={() => { supplementTouch.current = false; send({ type: 'pressCancelled' }); }}
              onTouchEnd={e => {
                const option = (e.target as Element).closest('button');
                if (!supplementTouch.current || !option) return;
                supplementTouch.current = false;
                e.preventDefault();
                option.click();
              }}>
              {filteredOptions.slice(0, 8).map(opt => (
                <button
                  key={opt.key}
                  type="button"
                  className="supplement-dropdown-item"
                  onClick={() => addSupplement(opt.key, opt.name, opt.defaultDose, opt.defaultUnit)}
                >
                  {opt.name}
                </button>
              ))}
              {canAddCustomSupplement && (
                <button
                  type="button"
                  className="supplement-dropdown-item supplement-custom"
                  onClick={addCustomSupplement}
                >
                  + Add "{trimmedSearch}"
                </button>
              )}
            </div>
          )}
          </>)}
        </div>
      </section>
    </div>
  );
}

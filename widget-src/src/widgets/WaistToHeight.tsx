// The waist-to-height and BMI widget (US-74): height, weight and waist, saved
// to the record the full app reads, and the plan's own results for them.
import { useEffect, useReducer, useRef, useState } from 'react';
import { statTileText, type StatTile } from '@roadmap/health-core/stat-tiles';
import { getDisplayLabel, type UnitSystem } from '@roadmap/health-core/units';
import { trackProductEvent } from '../lib/server-api';
import {
  boxesFor, measuredErrors, measuredFrom, recordMeasured, resultsFor, safeHref, saveMeasured, startingUnits, todaysRows,
  type Boxes, type Results,
} from './body-measures';
import { START, transition } from './widget-machine';

export interface WidgetProps {
  /** The block's next-step link and its label (US-74 AC6); shown after a result, only when both are set. */
  nextUrl?: string;
  nextLabel?: string;
}

const UNIT_CHOICES: ReadonlyArray<[UnitSystem, string]> = [['si', 'Metric'], ['conventional', 'US']];

function Tile({ tile }: { tile: StatTile }) {
  return (
    <div className="hr-widget-tile">
      <div className="hr-widget-tile-label">{tile.label}</div>
      <div className="hr-widget-tile-value">{statTileText(tile)}</div>
      {tile.status && <div className={`hr-widget-status hr-widget-status--${tile.status.tone ?? 'none'}`}>{tile.status.label}</div>}
      <p className="hr-widget-about">{tile.about}</p>
    </div>
  );
}

/** The results, in a live region that is on the page before they arrive, so a
 *  screen reader reads them out (one inserted with its content often is not).
 *  An <output>, not a div: the storefront hides an empty div. */
function ResultsView({ results }: { results: Results | null }) {
  return (
    <output className="hr-widget-results" aria-live="polite">
      {results && <>
        {results.whtr && <Tile tile={results.whtr} />}
        {results.bmi && <Tile tile={results.bmi} />}
        <p className="hr-widget-target">{results.target}</p>
      </>}
    </output>
  );
}

export function WaistToHeightWidget({ nextUrl, nextLabel }: WidgetProps) {
  const [system, setSystem] = useState<UnitSystem>(startingUnits);
  const [boxes, setBoxes] = useState<Boxes>(() => boxesFor(recordMeasured(), system));
  const [state, dispatch] = useReducer(transition, START);
  // Today's rows as this page last read them: what a save expects to replace (US-74 AC4).
  const expected = useRef(todaysRows());

  useEffect(() => { trackProductEvent('waist_widget_viewed'); }, []);

  const edit = (field: keyof Boxes) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setBoxes((prev) => ({ ...prev, [field]: value }));
    dispatch({ type: 'edited' });
  };

  const switchUnits = (to: UnitSystem) => {
    if (to === system || state.mode === 'saving') return;
    setBoxes(boxesFor(measuredFrom(boxes, system), to));
    setSystem(to);
    dispatch({ type: 'edited' });
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (state.mode === 'saving') return;
    const values = measuredFrom(boxes, system);
    const errors = measuredErrors(values, system);
    dispatch({ type: 'submitted', errors });
    if (Object.keys(errors).length > 0 || values.heightCm === undefined) return;
    // A save that throws ends as one refused, never as "Saving…" for good.
    const outcome = await saveMeasured(values, system, expected.current).catch(() => null);
    if (outcome) expected.current = outcome.today;
    if (!outcome?.saved) { dispatch({ type: 'failed' }); return; }
    trackProductEvent('waist_widget_saved');
    dispatch({ type: 'saved', results: resultsFor({ ...values, heightCm: values.heightCm }, system) });
  };

  const errors = state.mode === 'editing' ? state.errors : {};
  const href = safeHref(nextUrl);
  const heightError = errors.heightCm ? 'hr-widget-height-error' : undefined;
  const box = (field: 'height' | 'weight' | 'waist', id: string, label: string, error: string | undefined, optional: boolean) => (
    <div className="hr-widget-field">
      <label htmlFor={id}>{label} ({getDisplayLabel(field, system)}){optional && <span className="hr-widget-optional"> optional</span>}</label>
      <input id={id} type="text" inputMode="decimal" autoComplete="off" value={boxes[field]} onChange={edit(field)}
        aria-invalid={!!error} aria-describedby={error ? `${id}-error` : undefined} />
      {error && <span id={`${id}-error`} className="hr-widget-error">{error}</span>}
    </div>
  );

  return (
    <form className="hr-widget-form" onSubmit={submit} noValidate>
      <div className="hr-widget-units" role="radiogroup" aria-label="Units">
        {UNIT_CHOICES.map(([unit, label]) => (
          <button key={unit} type="button" role="radio" aria-checked={system === unit}
            className={`hr-widget-unit${system === unit ? ' hr-widget-unit--active' : ''}`} onClick={() => switchUnits(unit)}>
            {label}
          </button>
        ))}
      </div>
      {system === 'si' ? box('height', 'hr-widget-height', 'Height', errors.heightCm, false) : (
        <div className="hr-widget-field">
          <label id="hr-widget-height-label" htmlFor="hr-widget-feet">Height (ft/in)</label>
          <div className="hr-widget-pair" role="group" aria-labelledby="hr-widget-height-label">
            <input id="hr-widget-feet" type="text" inputMode="numeric" autoComplete="off" aria-label="Feet" value={boxes.feet} onChange={edit('feet')}
              aria-invalid={!!errors.heightCm} aria-describedby={heightError} />
            <span aria-hidden="true">ft</span>
            <input id="hr-widget-inches" type="text" inputMode="numeric" autoComplete="off" aria-label="Inches" value={boxes.inches} onChange={edit('inches')}
              aria-invalid={!!errors.heightCm} aria-describedby={heightError} />
            <span aria-hidden="true">in</span>
          </div>
          {errors.heightCm && <span id="hr-widget-height-error" className="hr-widget-error">{errors.heightCm}</span>}
        </div>
      )}
      {box('weight', 'hr-widget-weight', 'Weight', errors.weightKg, true)}
      {box('waist', 'hr-widget-waist', 'Waist', errors.waistCm, true)}
      {/* aria-disabled, not disabled: a disabled button drops the keyboard's focus mid-save. submit() ignores a press while saving. */}
      <button type="submit" className="hr-widget-submit" aria-disabled={state.mode === 'saving'}>
        {state.mode === 'saving' ? 'Saving…' : 'See my results'}
      </button>
      {state.mode === 'failed' && <p className="hr-widget-error" role="alert">Not saved. Reload the page and try again.</p>}
      <ResultsView results={state.mode === 'shown' ? state.results : null} />
      {state.mode === 'shown' && href && nextLabel?.trim() && <a className="hr-widget-next" href={href}>{nextLabel.trim()}</a>}
    </form>
  );
}

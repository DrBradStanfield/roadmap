// The waist-to-height and BMI widget (US-74): height, weight and waist, saved
// to the record the full app reads, and the plan's own results for that record.
import { useEffect, useId, useReducer, useRef, useState } from 'react';
import { statTileText, type StatTile } from '@roadmap/health-core/stat-tiles';
import { getDisplayLabel, type UnitSystem } from '@roadmap/health-core/units';
import { trackProductEvent } from '../lib/server-api';
import { recordMeasured, recordResults, safeHref, saveMeasured, seenAfterFailure, seenNow, startingUnits, type Results } from './body-measures';
import { FIELDS, INPUT_OF, boxesFor, readBoxes, switchBoxes, typed, type Boxes, type Field } from './boxes';
import { START, transition, type PartlyKept } from './widget-machine';

export interface WidgetProps {
  /** The block's next-step link and its label (US-74 AC6); shown after a result when the link is set. */
  nextUrl?: string;
  nextLabel?: string;
}

const UNIT_CHOICES: ReadonlyArray<[UnitSystem, string]> = [['si', 'Metric'], ['conventional', 'US']];
/** The link's words when the block sets a link and no label (review U2). */
export const NEXT_STEP_DEFAULT = 'Next step';
export const NOT_SAVED = 'Not saved. Reload the page and try again.';

/** One tile. Its status has one fixed class: a class naming the grade would
 *  reach a Clarity replay, which records class attributes under the text mask (review P1). */
function Tile({ tile }: { tile: StatTile }) {
  return (
    <div className="hr-widget-tile">
      <div className="hr-widget-tile-label">{tile.label}</div>
      <div className="hr-widget-tile-value">{statTileText(tile)}</div>
      {tile.status && <div className="hr-widget-status">{tile.status.label}</div>}
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

const list = (fields: Field[]) => fields.join(', ');

/** What a part-kept save kept and did not (review A5). */
function PartlyKeptNotice({ partial }: { partial: PartlyKept }) {
  return (
    <div className="hr-widget-notice" role="alert">
      {partial.saved.length > 0 && <p>Saved: {list(partial.saved)}.</p>}
      {partial.changed.length > 0 && (
        <p>Not saved: {list(partial.changed)}. It changed on another device or tab, so the box now shows the saved value. Press again to replace it.</p>
      )}
      {partial.refused.length > 0 && <p>Not saved: {list(partial.refused)}. Check the value and press again.</p>}
    </div>
  );
}

export function WaistToHeightWidget({ nextUrl, nextLabel }: WidgetProps) {
  const id = useId(); // per block, so two blocks on a page never share an id (review U1)
  const [system, setSystem] = useState<UnitSystem>(startingUnits);
  const [boxes, setBoxes] = useState<Boxes>(() => boxesFor(recordMeasured(), system));
  const [state, dispatch] = useReducer(transition, START);
  // What the person has seen of the record: all a save may replace (US-74 AC4, review A4).
  const seen = useRef(seenNow());
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => { trackProductEvent('waist_widget_viewed'); }, []);

  // A press with errors moves to the first box at fault, which reads out its error (review U6).
  const errors = state.mode === 'editing' ? state.errors : {};
  useEffect(() => {
    if (state.mode === 'editing' && Object.keys(state.errors).length > 0) formRef.current?.querySelector<HTMLInputElement>('input[aria-invalid="true"]')?.focus();
  }, [state]);

  const edit = (field: Field, part: 'text' | 'inches' = 'text') => (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setBoxes((prev) => ({ ...prev, [field]: typed(prev[field], part, value) }));
    dispatch({ type: 'edited' });
  };

  const switchUnits = (to: UnitSystem) => {
    if (to === system || state.mode === 'saving') return;
    setBoxes(switchBoxes(boxes, system, to));
    setSystem(to);
    dispatch({ type: 'edited' });
  };
  // Arrow keys move the choice, as a radio group's do (review U6).
  const unitKeys = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault();
    const to = system === 'si' ? 'conventional' : 'si';
    switchUnits(to);
    e.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`[data-unit="${to}"]`)?.focus();
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (state.mode === 'saving') return;
    const { values, entered, errors: found } = readBoxes(boxes, system);
    dispatch({ type: 'submitted', errors: found });
    if (Object.keys(found).length > 0) return;
    // A save that throws ends as one the store could not keep, never as "Saving…" for good.
    const outcome = await saveMeasured(values, entered, seen.current).catch(() => ({ kind: 'failed' as const }));
    if (outcome.kind === 'failed') {
      // The drafts stay for another press; only the person's own entries count as seen (A3, A4).
      seen.current = seenAfterFailure(seen.current, values, entered);
      dispatch({ type: 'failed' });
      return;
    }
    // The boxes now show the record, except an entry the store refused, which
    // stays to be fixed; what the person sees is what a next save may replace.
    const now = seenNow(), shown = boxesFor(recordMeasured(), system);
    const kept = new Set(outcome.refused);
    setBoxes((prev) => Object.fromEntries(FIELDS.map((f) => [f, kept.has(f) ? prev[f] : shown[f]])) as Boxes);
    seen.current = {
      heightCm: kept.has('height') ? seen.current.heightCm : now.heightCm,
      today: { weight: kept.has('weight') ? seen.current.today.weight : now.today.weight, waist: kept.has('waist') ? seen.current.today.waist : now.today.waist },
    };
    // Counted once a waist is kept, so a ratio exists (review P3); the name alone.
    if (outcome.saved.includes('waist')) trackProductEvent('waist_widget_saved');
    const partial = outcome.changed.length > 0 || outcome.refused.length > 0 ? { saved: outcome.saved, changed: outcome.changed, refused: outcome.refused } : null;
    dispatch({ type: 'saved', results: recordResults(system), partial });
  };

  const href = safeHref(nextUrl);
  const ids = { height: `${id}-height`, feet: `${id}-feet`, inches: `${id}-inches`, weight: `${id}-weight`, waist: `${id}-waist` };
  const errorId = (field: Field) => `${id}-${field}-error`;
  const errorOf = (field: Field) => errors[INPUT_OF[field]];
  const described = (field: Field) => (errorOf(field) ? errorId(field) : undefined);
  const errorLine = (field: Field) => errorOf(field) && <span id={errorId(field)} className="hr-widget-error">{errorOf(field)}</span>;
  const box = (field: Field, label: string, optional: boolean) => (
    <div className="hr-widget-field">
      <label htmlFor={ids[field]}>{label} ({getDisplayLabel(field, system)}){optional && <span className="hr-widget-optional"> optional</span>}</label>
      <input id={ids[field]} type="text" inputMode="decimal" autoComplete="off" value={boxes[field].text} onChange={edit(field)}
        aria-invalid={!!errorOf(field)} aria-describedby={described(field)} />
      {errorLine(field)}
    </div>
  );

  return (
    <form ref={formRef} className="hr-widget-form" onSubmit={submit} noValidate>
      <div className="hr-widget-units" role="radiogroup" aria-label="Units">
        {UNIT_CHOICES.map(([unit, label]) => (
          <button key={unit} type="button" role="radio" aria-checked={system === unit} tabIndex={system === unit ? 0 : -1} data-unit={unit}
            className={`hr-widget-unit${system === unit ? ' hr-widget-unit--active' : ''}`} onClick={() => switchUnits(unit)} onKeyDown={unitKeys}>
            {label}
          </button>
        ))}
      </div>
      {system === 'si' ? box('height', 'Height', false) : (
        <div className="hr-widget-field">
          <label id={`${id}-height-label`} htmlFor={ids.feet}>Height (ft/in)</label>
          <div className="hr-widget-pair" role="group" aria-labelledby={`${id}-height-label`}>
            <input id={ids.feet} type="text" inputMode="numeric" autoComplete="off" aria-label="Feet" value={boxes.height.text} onChange={edit('height')}
              aria-invalid={!!errorOf('height')} aria-describedby={described('height')} />
            <span aria-hidden="true">ft</span>
            <input id={ids.inches} type="text" inputMode="numeric" autoComplete="off" aria-label="Inches" value={boxes.height.inches} onChange={edit('height', 'inches')}
              aria-invalid={!!errorOf('height')} aria-describedby={described('height')} />
            <span aria-hidden="true">in</span>
          </div>
          {errorLine('height')}
        </div>
      )}
      {box('weight', 'Weight', true)}
      {box('waist', 'Waist', true)}
      {/* aria-disabled, not disabled: a disabled button drops the keyboard's focus mid-save. submit() ignores a press while saving. */}
      <button type="submit" className="hr-widget-submit" aria-disabled={state.mode === 'saving'}>
        {state.mode === 'saving' ? 'Saving…' : 'See my results'}
      </button>
      {state.mode === 'failed' && <p className="hr-widget-error" role="alert">{NOT_SAVED}</p>}
      {state.mode === 'shown' && state.partial && <PartlyKeptNotice partial={state.partial} />}
      <ResultsView results={state.mode === 'shown' ? state.results : null} />
      {state.mode === 'shown' && state.results && href && <a className="hr-widget-next" href={href}>{nextLabel?.trim() || NEXT_STEP_DEFAULT}</a>}
    </form>
  );
}

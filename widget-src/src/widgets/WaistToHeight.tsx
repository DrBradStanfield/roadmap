// The waist-to-height and BMI widget (US-74): height, weight and waist, saved
// as the full app saves them, with the plan's own results shown as they are typed.
//
// Saving is automatic, on the full app's own timings (Brad 2026-11-18): the
// height, a profile answer, 500 ms after it is typed, as About you saves it
// (useProfileSave's useDebouncedSave(500)); the weight and waist, day values,
// when the person leaves their two boxes or presses Enter, as the vitals grid
// commits a typed cell (useSaveOnLeave). Only an entry that reads and is in
// range is saved; a half-typed number is never one, and a later change the
// same day corrects today's row (saveMeasured).
import { useEffect, useId, useMemo, useReducer, useRef, useState } from 'react';
import { localDay } from '@roadmap/health-core/merge';
import { getDisplayLabel, type UnitSystem } from '@roadmap/health-core/units';
import { formatShortDate } from '../lib/constants';
import { trackProductEvent } from '../lib/server-api';
import { useDebouncedSave } from '../lib/useDebouncedSave';
import { useSaveOnLeave } from '../lib/useSaveOnLeave';
import {
  recordDays, recordMeasured, resultsFor, safeHref, saveMeasured, seenAfterFailure, seenNow, startingUnits,
} from './body-measures';
import { FIELDS, INPUT_OF, boxesFor, readBox, readBoxes, settle, switchBoxes, typed, type Boxes, type Field, type Measured, type Part } from './boxes';
import { START, transition, type PartlyKept } from './widget-machine';
import { ResultsView } from './WidgetResults';

export interface WidgetProps {
  /** The block's next-step link and its label (US-74 AC6); shown with a result when the link is set. */
  nextUrl?: string;
  nextLabel?: string;
}

const UNIT_CHOICES: ReadonlyArray<[UnitSystem, string]> = [['si', 'Metric'], ['conventional', 'US']];
/** The link's words when the block sets a link and no label (review U2). */
export const NEXT_STEP_DEFAULT = 'Next step';
/** The drafts stay, and the next save tries again (review X7). */
export const NOT_SAVED = 'Not saved. Your entries are kept and will save when you next leave a box; reload the page if this keeps happening.';
/** This widget's own words for each box (Brad 2026-11-18); the full app's tile labels are unchanged. */
const LABEL: Record<Field, string> = { height: 'Height', weight: 'Weight', waist: 'Waist circumference' };
const NAME: Record<Field, string> = { height: 'height', weight: 'weight', waist: 'waist circumference' };
const DAY_FIELDS: readonly Field[] = ['waist', 'weight'];

const list = (fields: Field[]) => fields.map((f) => NAME[f]).join(', ');

/** What a part-kept save kept and did not (review A5, X1). */
function PartlyKeptNotice({ partial }: { partial: PartlyKept }) {
  return (
    <div className="hr-widget-notice" role="alert">
      {partial.saved.length > 0 && <p>Saved: {list(partial.saved)}.</p>}
      {partial.changed.length > 0 && (
        <p>Not saved: {list(partial.changed)}. It changed on another device or tab, so the box now shows the saved value. Type a new value to replace it.</p>
      )}
      {partial.refused.length > 0 && <p>Not saved: {list(partial.refused)}. Check the value.</p>}
    </div>
  );
}

/** The day a box's value comes from, while it still shows the record's (review X2). */
function fromDay(day: string | undefined): string | null {
  if (!day) return null;
  return day === localDay(new Date()) ? 'today' : `from ${formatShortDate(day)}`;
}

export function WaistToHeightWidget({ nextUrl, nextLabel }: WidgetProps) {
  const id = useId(); // per block, so two blocks on a page never share an id (review U1)
  const [system, setSystem] = useState<UnitSystem>(startingUnits);
  const [boxes, setBoxes] = useState<Boxes>(() => boxesFor(recordMeasured(), system));
  const [days, setDays] = useState(recordDays);
  const [state, dispatch] = useReducer(transition, START);
  // Boxes whose error shows: left, or Enter pressed (the full app shows a range error once a box is left).
  const [left, setLeft] = useState<ReadonlySet<Field>>(new Set());
  // What the person has seen of the record: all a save may replace (US-74 AC4, review A4).
  const seen = useRef(seenNow());
  // The boxes and units as they are now, for a save that ends after more typing.
  const now = useRef({ boxes, system });
  now.current = { boxes, system };
  // Saves run one after another (handle of the queue, as useLongitudinalSave's savesRef).
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  // Which input takes the focus after Enter with errors (review U6, C11): view state, not a mode.
  const focusTo = useRef<string | null>(null);
  const heightTimer = useDebouncedSave(500);
  // waist_widget_saved goes once per page view, the first time a waist is kept (Brad 2026-11-18).
  const savedCounted = useRef(false);
  const dayRow = useRef<HTMLDivElement>(null);

  useEffect(() => { trackProductEvent('waist_widget_viewed'); }, []);

  const ids = { height: `${id}-height`, feet: `${id}-feet`, inches: `${id}-inches`, weight: `${id}-weight`, waist: `${id}-waist` };
  const read = useMemo(() => readBoxes(boxes, system), [boxes, system]);
  // Live (Brad 2026-11-18): the plan's results once a usable height and a waist or weight are in the boxes.
  const results = useMemo(() => {
    const { heightCm, weightKg, waistCm } = read.values;
    return heightCm !== undefined && (weightKg !== undefined || waistCm !== undefined) ? resultsFor(read.values, system) : null;
  }, [read, system]);

  useEffect(() => {
    if (!focusTo.current) return;
    document.getElementById(focusTo.current)?.focus();
    focusTo.current = null;
  }, [left]);

  /** Save the entries among `fields` that read and are in range; nothing else (US-74 AC4). */
  const save = (fields: readonly Field[]) => {
    const { boxes: snapshot, system: unit } = now.current;
    const { values, entered } = readBoxes(snapshot, unit);
    const chosen = new Set(fields.filter((f) => entered.has(f) && values[INPUT_OF[f]] !== undefined));
    if (chosen.size === 0) return;
    const run = async () => {
      dispatch({ type: 'started' });
      // A save that throws ends as one the store could not keep, never as "Saving…" for good.
      const outcome = await saveMeasured(values, chosen, seen.current, unit).catch(() => ({ kind: 'failed' as const, staged: { saved: [], inserted: [] } }));
      if (outcome.kind === 'failed') {
        // The drafts stay for the next save; only the person's own entries count as seen (A3, A4).
        seen.current = seenAfterFailure(seen.current, values, chosen, outcome.staged);
        dispatch({ type: 'failed' });
        return;
      }
      // Each saved box now holds the record's value, unless it was typed in
      // since this save began: that box is newer than the save, and stays (review C6).
      const record: Measured = recordMeasured(), fresh = seenNow(), refused = new Set(outcome.refused);
      const settled = new Set([...chosen].filter((f) => !refused.has(f)));
      setBoxes((prev) => {
        const out = { ...prev };
        for (const f of settled) if (prev[f] === snapshot[f]) out[f] = settle(f, prev[f], record[INPUT_OF[f]], now.current.system);
        return out;
      });
      setDays(recordDays());
      seen.current = {
        day: fresh.day,
        heightCm: settled.has('height') ? fresh.heightCm : seen.current.heightCm,
        today: {
          weight: settled.has('weight') ? fresh.today.weight : seen.current.today.weight,
          waist: settled.has('waist') ? fresh.today.waist : seen.current.today.waist,
        },
      };
      // Once a waist is written, so a ratio exists (review P3, C5); the name alone.
      if (outcome.saved.includes('waist') && !savedCounted.current) {
        savedCounted.current = true;
        trackProductEvent('waist_widget_saved');
      }
      const partial = outcome.changed.length > 0 || outcome.refused.length > 0 ? { saved: outcome.saved, changed: outcome.changed, refused: outcome.refused } : null;
      dispatch({ type: 'kept', partial });
    };
    const next = queue.current.then(run);
    queue.current = next.catch(() => undefined);
  };

  // The weight and waist commit as the vitals grid's cells do: on leaving their boxes.
  useSaveOnLeave(dayRow, () => save(DAY_FIELDS));

  const edit = (field: Field, part: Part = 'text') => (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setBoxes((prev) => ({ ...prev, [field]: typed(prev[field], part, value) }));
    setLeft((prev) => (prev.has(field) ? new Set([...prev].filter((f) => f !== field)) : prev));
    dispatch({ type: 'edited' });
    if (field === 'height') heightTimer.schedule(() => save(['height']));
  };
  const leave = (field: Field) => () => setLeft((prev) => (prev.has(field) ? prev : new Set([...prev, field])));
  // Enter saves every box now, and shows every box's error, the first at fault focused (review U6, C11).
  const enter = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    heightTimer.cancel();
    const first = FIELDS.find((f) => read.parts[f]);
    focusTo.current = !first ? null : first === 'height' && system === 'conventional' ? (read.parts.height === 'inches' ? ids.inches : ids.feet) : ids[first];
    setLeft(new Set(FIELDS));
    save(FIELDS);
  };

  const switchUnits = (to: UnitSystem) => {
    if (to === system) return;
    setBoxes(switchBoxes(boxes, system, to));
    setSystem(to);
  };
  // Arrow keys move the choice, as a radio group's do (review U6).
  const unitKeys = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault();
    const to = system === 'si' ? 'conventional' : 'si';
    switchUnits(to);
    e.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`[data-unit="${to}"]`)?.focus();
  };

  const href = safeHref(nextUrl);
  const errorId = (field: Field) => `${id}-${field}-error`;
  const errorOf = (field: Field) => (left.has(field) ? read.errors[INPUT_OF[field]] : undefined);
  const described = (field: Field, extra?: string) => [errorOf(field) ? errorId(field) : '', extra ?? ''].filter(Boolean).join(' ') || undefined;
  const errorLine = (field: Field) => errorOf(field) && <span id={errorId(field)} className="hr-widget-error">{errorOf(field)}</span>;
  // The day a weight or waist box's value comes from, while it still shows the record's.
  const dayNote = (field: Field) => {
    if (field === 'height') return null;
    const reading = readBox(field, boxes[field], system);
    return reading.kind === 'value' && !reading.entered ? fromDay(days[field as 'weight' | 'waist']) : null;
  };
  const input = (field: Field, part: Part, extra: Record<string, unknown> = {}) => (
    <input id={part === 'inches' ? ids.inches : field === 'height' && system === 'conventional' ? ids.feet : ids[field]}
      type="text" inputMode={field === 'height' && system === 'conventional' ? 'numeric' : 'decimal'} autoComplete="off"
      value={part === 'inches' ? boxes[field].inches : boxes[field].text} onChange={edit(field, part)} onBlur={leave(field)} onKeyDown={enter}
      aria-invalid={!!errorOf(field)} {...extra} />
  );
  const box = (field: Field, optional: boolean) => {
    const note = dayNote(field);
    const noteId = `${id}-${field}-day`;
    return (
      <div className="hr-widget-field">
        <label htmlFor={ids[field]}>{LABEL[field]}{optional && <small> (optional)</small>}</label>
        <span className="hr-widget-in">
          {input(field, 'text', { 'aria-describedby': described(field, note ? noteId : undefined) })}
          <em aria-hidden="true">{getDisplayLabel(field, system)}</em>
        </span>
        {note && <span id={noteId} className="hr-widget-day">{note}</span>}
        {errorLine(field)}
      </div>
    );
  };

  const status = state.mode === 'saving' ? <p className="hr-widget-saving">Saving…</p>
    : state.mode === 'saved' && !state.partial ? <p className="hr-widget-saving">Saved</p> : null;

  return (
    <form className="hr-widget-form" onSubmit={(e) => e.preventDefault()} noValidate>
      <div className="hr-widget-units" role="radiogroup" aria-label="Units">
        {UNIT_CHOICES.map(([unit, label]) => (
          <button key={unit} type="button" role="radio" aria-checked={system === unit} tabIndex={system === unit ? 0 : -1} data-unit={unit}
            className={`hr-widget-unit${system === unit ? ' hr-widget-unit--active' : ''}`} onClick={() => switchUnits(unit)} onKeyDown={unitKeys}>
            {label}
          </button>
        ))}
      </div>
      {system === 'si' ? box('height', false) : (
        <div className="hr-widget-field">
          <label id={`${id}-height-label`} htmlFor={ids.feet}>Height</label>
          <div className="hr-widget-pair" role="group" aria-labelledby={`${id}-height-label`}>
            <span className="hr-widget-in">
              {input('height', 'text', { 'aria-label': 'Feet', 'aria-describedby': described('height') })}
              <em aria-hidden="true">ft</em>
            </span>
            <span className="hr-widget-in">
              {input('height', 'inches', { 'aria-label': 'Inches', 'aria-describedby': described('height') })}
              <em aria-hidden="true">in</em>
            </span>
          </div>
          {errorLine('height')}
        </div>
      )}
      <div className="hr-widget-row" ref={dayRow}>
        {box('waist', true)}
        {box('weight', true)}
      </div>
      {state.mode === 'failed' && <p className="hr-widget-error" role="alert">{NOT_SAVED}</p>}
      {state.mode === 'saved' && state.partial && <PartlyKeptNotice partial={state.partial} />}
      <ResultsView results={results} status={status} />
      {results && href && <a className="hr-widget-next" href={href}>{nextLabel?.trim() || NEXT_STEP_DEFAULT}</a>}
    </form>
  );
}

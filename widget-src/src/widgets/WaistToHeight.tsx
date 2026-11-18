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
import { getDisplayLabel, getDisplayRange, type UnitSystem } from '@roadmap/health-core/units';
import { formatShortDate } from '../lib/constants';
import { trackProductEvent } from '../lib/server-api';
import { useDebouncedSave } from '../lib/useDebouncedSave';
import { useSaveOnLeave } from '../lib/useSaveOnLeave';
import { blockBadNumericKeys } from '../lib/blood-test-cell';
import { HeightBoxes } from '../components/HeightField';
import { focusById } from '../components/form-kit';
import { useAutoAdvance } from '../lib/useAutoAdvance';
import { recordDays, recordMeasured, resultsFor, safeHref, startingUnits } from './body-measures';
import { FIELDS, INPUT_OF, boxesFor, readBox, readBoxes, switchBoxes, typed, type Boxes, type Field, type Part } from './boxes';
import { useWidgetSave } from './useWidgetSave';
import { START, transition, type PartlyKept } from './widget-machine';
import { ResultsView } from './WidgetResults';

export interface WidgetProps {
  /** The block's next-step link and its label (US-74 AC6); shown with a result when the link is set. */
  nextUrl?: string;
  nextLabel?: string;
  /** How the link leaves the page; tests pass their own. */
  navigate?: (href: string) => void;
}

/** The link's words when the block sets a link and no label (review U2). */
export const NEXT_STEP_DEFAULT = 'Next step';
/** The drafts stay, and the next save tries again (review X7). */
export const NOT_SAVED = 'Not saved. Your entries are kept and will save when you next leave a box; reload the page if this keeps happening.';
/** This widget's own words for each box (Brad 2026-11-18); the full app's tile labels are unchanged. */
const LABEL: Record<Field, string> = { height: 'Height', weight: 'Weight', waist: 'Waist circumference' };
const NAME: Record<Field, string> = { height: 'height', weight: 'weight', waist: 'waist circumference' };

const UNIT_CHOICES: ReadonlyArray<[UnitSystem, string]> = [['si', 'Metric'], ['conventional', 'US']];
/** The cm box's min and max, as About you sets them. */
const heightRange = getDisplayRange('height', 'si');

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

/** The day a box's value comes from, while it still shows an older day's (review X2). Today's needs no note (Brad 2026-11-18). */
function fromDay(day: string | undefined): string | null {
  if (!day || day === localDay(new Date())) return null;
  return `from ${formatShortDate(day)}`;
}

export function WaistToHeightWidget({ nextUrl, nextLabel, navigate = (href) => window.location.assign(href) }: WidgetProps) {
  const id = useId(); // per block, so two blocks on a page never share an id (review U1)
  const [system, setSystem] = useState<UnitSystem>(startingUnits);
  const [boxes, setBoxes] = useState<Boxes>(() => boxesFor(recordMeasured(), system));
  const [days, setDays] = useState(recordDays);
  const [state, dispatch] = useReducer(transition, START);
  // Boxes whose error shows: left, or Enter pressed (the full app shows a range error once a box is left).
  const [left, setLeft] = useState<ReadonlySet<Field>>(new Set());
  // The cm box holds text the browser could not read ("175,5" gives "" with validity.badInput), as About you's (US-02 AC7).
  const [heightUnreadable, setHeightUnreadable] = useState(false);
  // The boxes and units as they are now, for a save that ends after more typing.
  const now = useRef({ boxes, system });
  now.current = { boxes, system };
  // Which input takes the focus after Enter with errors (review U6, C11): view state, not a mode.
  const focusTo = useRef<string | null>(null);
  const heightTimer = useDebouncedSave(500);
  const advanceToWaist = useAutoAdvance();
  const dayRow = useRef<HTMLDivElement>(null);
  /** Save the entries among `fields` that read and are in range, and any that did not save before (US-74 AC4). */
  const save = useWidgetSave({ now, setBoxes, setDays, dispatch });

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

  // The weight and waist commit as the vitals grid's cells do: on leaving their boxes. A height
  // still waiting on its timer goes with them, so "Saved" never shows before the height is kept (live check 2026-11-18).
  useSaveOnLeave(dayRow, () => { heightTimer.cancel(); void save(FIELDS); });
  // The next step waits for every valid entry to be kept: a height typed a moment ago is saved first (review R6).
  const follow = async (e: React.MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    const href = e.currentTarget.getAttribute('href')!;
    heightTimer.cancel();
    if (await save(FIELDS)) navigate(href);
  };

  const edit = (field: Field, part: Part = 'text') => (value: string) => {
    setBoxes((prev) => ({ ...prev, [field]: typed(prev[field], part, value, system) }));
    setLeft((prev) => (prev.has(field) ? new Set([...prev].filter((f) => f !== field)) : prev));
    dispatch({ type: 'edited' });
    if (field === 'height') heightTimer.schedule(() => { void save(['height']); });
  };
  /** A complete height moves on to the waist (Brad 2026-11-18), with the full app's auto-advance, as
   *  About you's height moves on to the weight. Metric: a whole 3-digit cm in range, after the helper's
   *  short wait, so "178.5" can still be typed. US: inches that can take no further digit (two, or one
   *  of 2 to 9), the feet and inches in range, at once. Never a height with an error. */
  const heightTyped = (part: Part, value: string) => {
    const height = readBoxes({ ...boxes, height: typed(boxes.height, part, value, system) }, system);
    const complete = system === 'si' ? /^\d{3}$/.test(value) : part === 'inches' && /^(\d{2}|[2-9])$/.test(value);
    const valid = height.values.heightCm !== undefined && !height.errors.heightCm;
    advanceToWaist(complete && valid ? { ambiguous: system === 'si', advance: () => focusById(ids.waist) } : null);
  };
  const leave = (field: Field) => () => setLeft((prev) => (prev.has(field) ? prev : new Set([...prev, field])));
  // Enter saves every box now, and shows every box's error, the first at fault focused (review U6, C11).
  const enter = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    heightTimer.cancel();
    advanceToWaist(null);
    const first = FIELDS.find((f) => read.parts[f]);
    focusTo.current = !first ? null : first === 'height' && system === 'conventional' ? (read.parts.height === 'inches' ? ids.inches : ids.feet) : ids[first];
    setLeft(new Set(FIELDS));
    void save(FIELDS);
  };

  // The Metric / US switch converts every box (Brad 2026-11-18: the widget keeps its own switch).
  const switchUnits = (to: UnitSystem) => {
    if (to === system) return;
    setBoxes(switchBoxes(boxes, system, to));
    setSystem(to);
    setHeightUnreadable(false);
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
  const errorOf = (field: Field) => (!left.has(field) ? undefined
    : field === 'height' && heightUnreadable ? 'Enter a number' : read.errors[INPUT_OF[field]]);
  const described = (field: Field, extra?: string) => [errorOf(field) ? errorId(field) : '', extra ?? ''].filter(Boolean).join(' ') || undefined;
  // The day a weight or waist box's value comes from, while it still shows the record's.
  const dayNote = (field: Field) => {
    if (field === 'height') return null;
    const reading = readBox(field, boxes[field], system);
    return reading.kind === 'value' && !reading.entered ? fromDay(days[field as 'weight' | 'waist']) : null;
  };
  // Weight and waist: the full app's field box, read by the vitals grid's rules (boxes.ts) behind its key filter.
  const box = (field: 'weight' | 'waist', optional: boolean) => {
    const note = dayNote(field);
    const noteId = `${id}-${field}-day`;
    const error = errorOf(field);
    return (
      <div className="health-field">
        <label htmlFor={ids[field]}>{LABEL[field]} <span>({getDisplayLabel(field, system)})</span>{optional && <> <small>(optional)</small></>}</label>
        <input id={ids[field]} type="text" inputMode="decimal" pattern="[0-9.,]*" autoComplete="off"
          value={boxes[field].text} onChange={(e) => edit(field)(e.target.value)} onBlur={leave(field)}
          onKeyDown={(e) => { blockBadNumericKeys(e); enter(e); }}
          aria-invalid={!!error} aria-describedby={described(field, note ? noteId : undefined)} className={error ? 'error' : ''} />
        {note && <span id={noteId} className="hr-widget-day">{note}</span>}
        {error && <span id={errorId(field)} className="error-message">{error}</span>}
      </div>
    );
  };

  // The line is always there, blank when there is nothing to say: a line appearing would push the
  // next-step link down under a tap already on its way (live check 2026-11-18, iPhone).
  const status = <p className="hr-widget-saving">{state.phase === 'saving' ? 'Saving…' : state.phase === 'saved' && !state.partial ? 'Saved' : ''}</p>;

  return (
    <form className="hr-widget-form" onSubmit={(e) => e.preventDefault()} noValidate>
      <div className="hr-widget-top">
        <HeightBoxes
          unitSystem={system}
          pill={false}
          ids={{ cm: ids.height, feet: ids.feet, inches: ids.inches }}
          attention={false}
          error={errorOf('height')}
          invalid={!!errorOf('height')}
          cm={boxes.height.text}
          range={heightRange}
          onCm={(e) => { setHeightUnreadable(e.target.validity.badInput); edit('height')(e.target.value); heightTyped('text', e.target.value); }}
          onCmBlur={leave('height')}
          feet={boxes.height.text}
          inches={boxes.height.inches}
          onFeet={(v) => { edit('height', 'text')(v); heightTyped('text', v); }}
          onInches={(v) => { edit('height', 'inches')(v); heightTyped('inches', v); }}
          onPairLeave={leave('height')}
          onKeyDown={enter}
        />
        <div className="hr-widget-units" role="radiogroup" aria-label="Units">
          {UNIT_CHOICES.map(([unit, label]) => (
            <button key={unit} type="button" role="radio" aria-checked={system === unit} tabIndex={system === unit ? 0 : -1} data-unit={unit}
              className={`hr-widget-unit${system === unit ? ' hr-widget-unit--active' : ''}`} onClick={() => switchUnits(unit)} onKeyDown={unitKeys}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="hr-widget-row" ref={dayRow}>
        {box('waist', false)}
        {box('weight', true)}
      </div>
      {state.phase === 'failed' && <p className="hr-widget-error" role="alert">{NOT_SAVED}</p>}
      {state.phase === 'saved' && state.partial && <PartlyKeptNotice partial={state.partial} />}
      <ResultsView results={results} status={status} />
      {results && href && <a className="hr-widget-next" href={href} onClick={follow}>{nextLabel?.trim() || NEXT_STEP_DEFAULT}</a>}
    </form>
  );
}

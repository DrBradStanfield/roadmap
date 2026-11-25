// The blood pressure widget (US-75): one or two readings, their average, its
// stage and the full roadmap's own card for it, live as they are typed, and
// the average saved as today's pair. No save messages (Brad 2026-11-18).
//
// Clarity records class, style and attribute values as they are, and the
// length of masked text (US-74 AC5): nothing here varies with the stage or the
// value, and every result text is padded to one length (US-75 AC7).
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { BP_TIER_SHORT, type BpTier } from '@roadmap/health-core/bp-tier';
import { localDay } from '@roadmap/health-core/merge';
import { formatShortDate } from '../lib/constants';
import { trackProductEvent } from '../lib/server-api';
import { useBpPair } from '../lib/useBpPair';
import { useSaveOnLeave } from '../lib/useSaveOnLeave';
import { NO_SAVES, averageOf, bpPageView, readReading, recordPair, resultFor, rowsOn, savePair, transition, type Ids, type Result, type SaveOutcome, type Saves, type Typed } from './blood-pressure';
import { safeHref } from './body-measures';
import { FollowErase, useTreeErase } from './FollowErase';
import { NEXT_STEP_DEFAULT, type WidgetProps } from './WaistToHeight';
import { PILL, canvasDraws, drawPill, fixed } from './WidgetResults';

/** Result text lengths, each padded with WidgetResults' word joiner (fixed), which Clarity counts and
 *  no one sees: "250/150", the longest tier name, and the plan's longest card (the stage 2 card with
 *  its medicine and both lifestyle sentences), with room. Tested against every card. */
export const WIDTH = { value: 7, tier: Math.max(...Object.values(BP_TIER_SHORT).map((label) => label.length)), advice: 1000 } as const;
/** The plan's card opens "Your BP of"; on this page the abbreviation is spelled out on first use (Brad
 *  2026-11-19). Only the page's copy changes; the card itself, everywhere else, is the engine's. */
export const spelledOut = (text: string | undefined) => text?.replace(/^Your BP of /, 'Your blood pressure of ');
/** The pill's colour by tier (Brad 2026-11-18): green Normal, amber Elevated and Stage 1, red Stage 2 and crisis. */
const TONE: Record<BpTier, keyof typeof PILL> = { normal: 'green', elevated: 'amber', stage1: 'amber', stage2: 'red', crisis: 'red' };

const EMPTY: Typed = { sys: '', dia: '' };
const NONE: Ids = { sys: null, dia: null };
const LABEL = { sys: 'Systolic', dia: 'Diastolic' } as const; // Brad 2026-11-19

/** One reading's two boxes: the full app's blood pressure pair (useBpPair, US-75 AC2). */
function ReadingBoxes({ index, typed, note, onChange, onEnter, next, sysRef }: {
  index: number; typed: Typed; note: string | null;
  onChange: (typed: Typed) => void; onEnter: () => void;
  next?: () => HTMLInputElement | null; sysRef: React.RefObject<HTMLInputElement>;
}) {
  const id = useId();
  const pair = useBpPair({
    sys: typed.sys, dia: typed.dia, next, onEnter,
    onSysChange: (sys) => onChange({ ...typed, sys }), onDiaChange: (dia) => onChange({ ...typed, dia }),
  });
  const errorId = (h: 'sys' | 'dia') => `${id}-${h}-error`;
  const diaOwn = pair.diaError && pair.diaError !== pair.sysError ? pair.diaError : undefined;
  const box = (h: 'sys' | 'dia') => {
    const error = h === 'sys' ? pair.sysError : diaOwn;
    const invalid = !!(h === 'sys' ? pair.sysError : pair.diaError);
    // A pair's error shows once, under the top number, and describes both boxes.
    const described = [invalid ? (h === 'dia' && !diaOwn ? errorId('sys') : errorId(h)) : '', note ? `${id}-day` : ''].filter(Boolean).join(' ') || undefined;
    return (
      <div className="health-field">
        <label htmlFor={`${id}-${h}`}>{LABEL[h]}</label>
        <input id={`${id}-${h}`} ref={h === 'sys' ? sysRef : pair.diaRef} type="text" inputMode="numeric" pattern="[0-9]*" autoComplete="off"
          value={typed[h]} onChange={(e) => (h === 'sys' ? pair.handleSysChange : pair.handleDiaChange)(e.target.value)}
          onKeyDown={pair.onKey} onBlur={pair.settle} aria-invalid={invalid} aria-describedby={described} />
        {error && <span id={errorId(h)} className="error-message">{error}</span>}
      </div>
    );
  };
  return (
    <fieldset className="hr-widget-reading">
      <legend>Reading {index + 1} <small>({index > 0 ? 'mmHg, optional' : 'mmHg'})</small></legend>
      <div className="hr-widget-row">{box('sys')}{box('dia')}</div>
      {note && <span id={`${id}-day`} className="hr-widget-day">{note}</span>}
    </fieldset>
  );
}

/** The average, its stage and the plan's card, in a live region on the page before they arrive. The
 *  stage's colour is a pill drawn on a canvas, as the waist widget's grade (review P1); where it draws,
 *  the stage's words are read out, not shown twice. That depends on the browser, never on the result. */
function BpResults({ result }: { result: Result | null }) {
  const pill = useRef<HTMLCanvasElement>(null);
  const [drawn, setDrawn] = useState(false);
  const tier = result ? result.tier ?? 'none' : null;
  useLayoutEffect(() => {
    // A known minor's result has no stage: the canvas is left blank, and `drawn` still says only whether it draws.
    if (tier) setDrawn(tier === 'none' ? canvasDraws(pill.current) : drawPill(pill.current, BP_TIER_SHORT[tier], PILL[TONE[tier]], true));
  }, [tier]);
  return (
    <output className="hr-widget-results" aria-live="polite">
      {result && (
        <div className="hr-widget-res">
          <div className="hr-widget-bp">
            <div className="hr-widget-k">Average blood pressure</div>
            <div className="hr-widget-v">{fixed(`${result.pair.sys}/${result.pair.dia}`, WIDTH.value)}<small className="hr-widget-mmhg"> mmHg</small></div>
            <canvas ref={pill} className="hr-widget-pill hr-widget-bp-pill" aria-hidden="true" />
            <span className={drawn ? 'hr-widget-sr' : 'hr-widget-status'}>{fixed(result.tier ? BP_TIER_SHORT[result.tier] : '', WIDTH.tier)}</span>
          </div>
          {/* One element whatever the card: its paragraphs are line breaks (pre-line), so their count is not
              in the page's structure. With no card (Normal, Elevated, a known minor) it is hidden, so the box
              ends under the pill (Brad 2026-11-19): its padded text still has a line's height. That a card shows
              is already in the page's height, an accepted gap (US-75); its words and length stay masked. */}
          <div className="hr-widget-advice" hidden={!result.card}>{fixed(spelledOut(result.card?.description), WIDTH.advice)}</div>
        </div>
      )}
    </output>
  );
}

export function BloodPressureWidget(props: WidgetProps) {
  // One view event per page view, however many blood pressure blocks the page holds (AC1, as US-74). Counted
  // above FollowErase: starting over after a newer erase is the same page view (AC8).
  useEffect(() => {
    if (bpPageView.mounted++ === 0) { bpPageView.savedCounted = false; trackProductEvent('bp_widget_viewed'); }
    return () => { bpPageView.mounted--; };
  }, []);
  return <FollowErase><BloodPressureForm {...props} /></FollowErase>;
}

function BloodPressureForm({ nextUrl, nextLabel, navigate = (href) => window.location.assign(href) }: WidgetProps) {
  // The erase this tree was mounted under: every save of its typing writes under it or not at all (AC8).
  const erase = useTreeErase();
  // The record's latest pair, shown until the person types (AC3): never averaged in, never saved.
  const [start] = useState(recordPair);
  const [prefilled, setPrefilled] = useState(!!start);
  // The day each reading was last typed on (null: not typed).
  const [typedOn, setTypedOn] = useState<[string | null, string | null]>([null, null]);
  const [readings, setReadings] = useState<[Typed, Typed]>(() => [start ? { sys: String(start.pair.sys), dia: String(start.pair.dia) } : EMPTY, EMPTY]);
  const sysRefs = [useRef<HTMLInputElement>(null), useRef<HTMLInputElement>(null)] as const;
  const form = useRef<HTMLFormElement>(null);
  // Saves (AC5), bound to what was asked: a save carries its edit's number, day, pair and the erase its typing
  // began under (Saves, AC8). `shown`: the day's rows this page may replace, the rows it showed or wrote itself,
  // as of an edit; after a drop, a newer edit takes the record's rows as they are then (the person typed again
  // after the change, as US-74 AC4).
  const saves = useRef<Saves>(NO_SAVES);
  const shown = useRef({ day: localDay(new Date()), ids: start?.day === localDay(new Date()) ? start.ids : NONE, asOf: 0 });
  const queue = useRef<Promise<unknown>>(Promise.resolve());

  // Only readings typed today count, and the record's while it shows: one typed before midnight is never
  // averaged into a new day's result or save (Codex 1876b R5); a save already asked keeps its own day.
  const today = localDay(new Date());
  const read = useMemo(() => readings.map((typed, i) => (prefilled || typedOn[i] === today ? readReading(typed) : { kind: 'blank' as const })), [readings, typedOn, prefilled, today]);
  const pairs = read.flatMap((r) => (r.kind === 'pair' ? [r.pair] : []));
  // Worked out once per set of readings, not per keystroke: the plan engine reads the whole record.
  const key = pairs.map((p) => `${p.sys}/${p.dia}`).join(' ');
  const result = useMemo(() => (pairs.length > 0 ? resultFor(pairs) : null), [key]); // `pairs` is new each render; `key` is its value

  /** Save the readings as typed now. Resolves true when nothing valid is waiting or the store kept it (AC5, AC6). */
  const save = (): Promise<boolean> => {
    const s = saves.current;
    if (s.edits <= s.kept || pairs.length === 0) return queue.current.then(() => true, () => true);
    // A complete reading held back by another reading's error: blocked, so the next step stays (Codex 1876b R7).
    // Settled with an edit not kept: its typing was dropped, and nothing has been typed since.
    if (read.some((r) => r.kind === 'error') || s.kind === 'settled') return Promise.resolve(false);
    // The erase its typing began under: the queued write lands under it or not at all (US-16 AC2a, AC8).
    const seq = s.edits, pair = averageOf(pairs), day = localDay(new Date()), erase = s.erase;
    const run = async (): Promise<boolean> => {
      const dropped = saves.current.dropped;
      if (seq <= dropped) return false;
      if (dropped > shown.current.asOf) shown.current = { day, ids: rowsOn(day), asOf: seq };
      const expected = shown.current.day === day ? shown.current.ids : NONE;
      const out = await savePair(pair, day, expected, erase).catch((): SaveOutcome => ({ kind: 'failed' }));
      if (out.kind === 'changed') { saves.current = transition(saves.current, { type: 'dropped', seq }); return false; }
      if (out.kind === 'failed') { if (out.ids) shown.current = { day, ids: out.ids, asOf: seq }; return false; }
      shown.current = { day, ids: out.ids, asOf: seq };
      saves.current = transition(saves.current, { type: 'kept', seq });
      if (!bpPageView.savedCounted) { bpPageView.savedCounted = true; trackProductEvent('bp_widget_saved'); }
      return true;
    };
    const next = queue.current.then(run);
    queue.current = next.catch(() => false);
    return next.catch(() => false);
  };
  useSaveOnLeave(form, () => { void save(); });
  // The next step leaves only once a valid typed reading is kept (as US-74 review R6); otherwise it stays, silently.
  const follow = async (e: React.MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    const to = e.currentTarget.getAttribute('href')!;
    if (await save()) navigate(to);
  };

  // The first edit clears the record's reading: a half from another day is never kept beside a typed one (AC3).
  const change = (i: 0 | 1) => (typed: Typed) => {
    saves.current = transition(saves.current, { type: 'typed', erase });
    // The load reserve for a returning visitor (the block's inline script) has done its job once they type:
    // from then on the card fits what it holds (Brad 2026-11-19).
    form.current?.closest('.hr-widget')?.classList.remove('hr-widget--saved');
    const day = localDay(new Date());
    setTypedOn((prev) => (prefilled ? (i === 0 ? [day, null] : [null, day]) : i === 0 ? [day, prev[1]] : [prev[0], day]));
    setReadings((prev) => {
      if (!prefilled) return i === 0 ? [typed, prev[1]] : [prev[0], typed];
      if (i === 1) return [EMPTY, typed];
      return [{ sys: typed.sys !== prev[0].sys ? typed.sys : '', dia: typed.dia !== prev[0].dia ? typed.dia : '' }, prev[1]];
    });
    setPrefilled(false);
  };
  const note = prefilled && start && start.day !== localDay(new Date()) ? `from ${formatShortDate(start.day)}` : null;
  const href = safeHref(nextUrl);

  return (
    <form ref={form} className="hr-widget-form" onSubmit={(e) => e.preventDefault()} noValidate>
      <ReadingBoxes index={0} typed={readings[0]} note={note} onChange={change(0)} onEnter={() => { void save(); }} sysRef={sysRefs[0]} next={() => sysRefs[1].current} />
      <ReadingBoxes index={1} typed={readings[1]} note={null} onChange={change(1)} onEnter={() => { void save(); }} sysRef={sysRefs[1]} />
      <BpResults result={result} />
      {result && href && <a className="hr-widget-next" href={href} onClick={follow}>{nextLabel?.trim() || NEXT_STEP_DEFAULT}</a>}
    </form>
  );
}

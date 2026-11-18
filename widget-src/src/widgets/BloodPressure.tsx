// The blood pressure widget (US-75): one or two readings, their average, its
// stage and the full roadmap's own card for it, live as they are typed, and
// the average saved as today's pair. No save messages (Brad 2026-11-18).
//
// Clarity records class, style and attribute values as they are, and the
// length of masked text (US-74 AC5): nothing here varies with the stage or the
// value, and every result text is padded to one length (US-75 AC7).
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { BP_TIER_LABEL, type BpTier } from '@roadmap/health-core/bp-tier';
import { localDay } from '@roadmap/health-core/merge';
import { formatShortDate } from '../lib/constants';
import { trackProductEvent } from '../lib/server-api';
import { useBpPair } from '../lib/useBpPair';
import { useSaveOnLeave } from '../lib/useSaveOnLeave';
import { averageOf, readReading, recordPair, resultFor, savePair, seenToday, type Pair, type Result, type Typed } from './blood-pressure';
import { safeHref } from './body-measures';
import { NEXT_STEP_DEFAULT, type WidgetProps } from './WaistToHeight';
import { PILL, drawPill, fixed } from './WidgetResults';

/** Result text lengths, each padded with WidgetResults' word joiner (fixed), which Clarity counts and
 *  no one sees: "250/150", the longest tier name, and the plan's longest card (the stage 2 card with
 *  its medicine and both lifestyle sentences), with room. Tested against every card. */
export const WIDTH = { value: 7, tier: 20, advice: 1000 } as const;
/** The pill's colour by tier (Brad 2026-11-18): green Normal, amber Elevated and Stage 1, red Stage 2 and crisis. */
const TONE: Record<BpTier, keyof typeof PILL> = { normal: 'green', elevated: 'amber', stage1: 'amber', stage2: 'red', crisis: 'red' };

const EMPTY: Typed = { sys: '', dia: '' };
const LABEL = { sys: 'Top number (systolic)', dia: 'Bottom number (diastolic)' } as const;

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
  const tier = result?.tier;
  useLayoutEffect(() => {
    if (tier) setDrawn(drawPill(pill.current, BP_TIER_LABEL[tier], PILL[TONE[tier]], true));
  }, [tier]);
  return (
    <output className="hr-widget-results" aria-live="polite">
      {result && (
        <div className="hr-widget-res">
          <div className="hr-widget-bp">
            <div className="hr-widget-k">Average blood pressure</div>
            <div className="hr-widget-v">{fixed(`${result.pair.sys}/${result.pair.dia}`, WIDTH.value)}<small className="hr-widget-mmhg"> mmHg</small></div>
            <canvas ref={pill} className="hr-widget-pill hr-widget-bp-pill" aria-hidden="true" />
            <span className={drawn ? 'hr-widget-sr' : 'hr-widget-status'}>{fixed(BP_TIER_LABEL[result.tier], WIDTH.tier)}</span>
          </div>
          {/* One element whatever the card: its paragraphs are line breaks (pre-line), so their count is not
              in the page's structure; Normal and Elevated leave it blank. */}
          <div className="hr-widget-advice">{fixed(result.card?.description, WIDTH.advice)}</div>
        </div>
      )}
    </output>
  );
}

export function BloodPressureWidget({ nextUrl, nextLabel, navigate = (href) => window.location.assign(href) }: WidgetProps) {
  const [start] = useState(recordPair);
  const [readings, setReadings] = useState<[Typed, Typed]>(() => [start ? { sys: String(start.pair.sys), dia: String(start.pair.dia) } : EMPTY, EMPTY]);
  // Which readings the person has typed in: a reading only filled from the record is not an entry (AC3).
  const [edited, setEdited] = useState<[boolean, boolean]>([false, false]);
  const sysRefs = [useRef<HTMLInputElement>(null), useRef<HTMLInputElement>(null)] as const;
  const form = useRef<HTMLFormElement>(null);
  // Today's rows the page has seen: all a save may replace (AC5).
  const seen = useRef(seenToday());
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const counted = useRef(false);

  useEffect(() => { trackProductEvent('bp_widget_viewed'); }, []);

  // An older day's reading left untouched is not today's: once the person types, it is left out (AC3).
  const oldPrefill = !!start && start.day !== localDay(new Date()) && !edited[0];
  const read = useMemo(() => readings.map((typed, i) => (i === 0 && oldPrefill && edited[1] ? { kind: 'blank' as const } : readReading(typed))), [readings, oldPrefill, edited]);
  const pairs = read.flatMap((r) => (r.kind === 'pair' ? [r.pair] : []));
  const average: Pair | null = pairs.length > 0 ? averageOf(pairs) : null;
  // Worked out once per average, not per keystroke: the plan engine reads the whole record.
  const [sys, dia] = [average?.sys, average?.dia];
  const result = useMemo(() => (sys !== undefined && dia !== undefined ? resultFor({ sys, dia }) : null), [sys, dia]);

  /** Saves run one after another; the returned promise ends when this one has. */
  const save = (): Promise<unknown> => {
    // Only the person's own entries, and only when no reading is wrong.
    if (!edited.some(Boolean) || !average || read.some((r) => r.kind === 'error')) return queue.current;
    const pair = average;
    return queue.current = queue.current.then(async () => {
      const kept = await savePair(pair, seen.current).catch(() => false);
      seen.current = seenToday();
      if (kept && !counted.current) {
        counted.current = true;
        trackProductEvent('bp_widget_saved');
      }
    });
  };
  useSaveOnLeave(form, save);
  // The next step waits for a typed reading to be saved first (as US-74 review R6).
  const follow = async (e: React.MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    const to = e.currentTarget.getAttribute('href')!;
    await save();
    navigate(to);
  };

  const change = (i: 0 | 1) => (typed: Typed) => {
    setReadings((prev) => (i === 0 ? [typed, prev[1]] : [prev[0], typed]));
    setEdited((prev) => (i === 0 ? [true, prev[1]] : [prev[0], true]));
  };
  const note = oldPrefill && start ? `from ${formatShortDate(start.day)}` : null;
  const href = safeHref(nextUrl);

  return (
    <form ref={form} className="hr-widget-form" onSubmit={(e) => e.preventDefault()} noValidate>
      <ReadingBoxes index={0} typed={readings[0]} note={note} onChange={change(0)} onEnter={save} sysRef={sysRefs[0]} next={() => sysRefs[1].current} />
      <ReadingBoxes index={1} typed={readings[1]} note={null} onChange={change(1)} onEnter={save} sysRef={sysRefs[1]} />
      <BpResults result={result} />
      {result && href && <a className="hr-widget-next" href={href} onClick={follow}>{nextLabel?.trim() || NEXT_STEP_DEFAULT}</a>}
    </form>
  );
}

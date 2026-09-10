import React from 'react';
import {AbsoluteFill, interpolate, spring} from 'remotion';
import {T, COL_W, SIDEBAR_W, STAGE_H} from '../theme';
import {Sidebar, Header, Composer} from '../Chrome';
import {UserBubble, ToolRow, StreamText} from '../blocks';
import {between, fadeIn, Cursor, SCENE_H} from '../ui';
import record from '../../record.json';

const LABEL: Record<string, [string, string]> = {
  apob: ['ApoB', 'g/L'],
  ldl: ['LDL', 'mmol/L'],
  hdl: ['HDL', 'mmol/L'],
  total_cholesterol: ['Total cholesterol', 'mmol/L'],
  triglycerides: ['Triglycerides', 'mmol/L'],
  lpa: ['Lp(a)', 'nmol/L'],
  hba1c: ['HbA1c', 'mmol/mol'],
  creatinine: ['Creatinine', 'µmol/L'],
  systolic_bp: ['Systolic BP', 'mmHg'],
  diastolic_bp: ['Diastolic BP', 'mmHg'],
  weight: ['Weight', 'kg'],
  waist: ['Waist', 'cm'],
  ferritin: ['Ferritin', 'µg/L'],
  tsh: ['TSH', 'mIU/L'],
  alt: ['ALT', 'U/L'],
};

// The matrix is built from the fictional record.json only: same dates, same metrics.
const cells: {metric: string; date: string; value: number}[] = [
  ...record.measurements.filter((m) => m.status === 'active').map((m) => ({metric: m.metricType, date: m.recordedAt, value: m.value})),
  ...record.labValues.filter((l) => l.status === 'active').map((l) => ({metric: l.metricName, date: l.recordedAt, value: l.value})),
];
const DATES = [...new Set(cells.map((c) => c.date))].sort();
/** The day the fictional record is being written on, its own column in the matrix. */
const TODAY = '2026-09-10';
const METRICS = Object.keys(LABEL).filter((k) => cells.some((c) => c.metric === k));
const fmt = (iso: string) => {
  const m = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const [y, mm] = iso.split('-');
  return `${m[Number(mm) - 1]} ${y}`;
};

const FRAME_L = 120;
const CONTENT_L = FRAME_L + 44;
const CONTENT_T = 40 + 58 + 28;

/** The browser chrome the site is shown in: a plain window, one URL bar. */
export const BrowserFrame: React.FC<{url: string; reload?: number; children: React.ReactNode}> = ({url, reload = 0, children}) => (
  <div style={{position: 'absolute', left: FRAME_L, right: FRAME_L, top: 40, bottom: 0, background: '#fff', borderRadius: '18px 18px 0 0', boxShadow: '0 10px 40px rgba(0,0,0,0.10)', overflow: 'hidden'}}>
    <div style={{height: 58, background: '#f3f4f4', borderBottom: '1px solid #e2e5e4', display: 'flex', alignItems: 'center', padding: '0 20px', gap: 8}}>
      {['#fe5f57', '#febc2e', '#28c840'].map((c) => (
        <span key={c} style={{width: 13, height: 13, borderRadius: 99, background: c}} />
      ))}
      <div style={{margin: '0 auto', background: '#fff', border: '1px solid #e2e5e4', borderRadius: 9, padding: '6px 18px', fontSize: 17, color: T.ink2, minWidth: 520, textAlign: 'center'}}>
        {url}
      </div>
    </div>
    <div style={{height: 3, background: 'transparent'}}>
      <div style={{height: 3, width: `${100 * Math.min(1, reload)}%`, background: T.accent, opacity: reload > 0 && reload < 1 ? 1 : 0}} />
    </div>
    <div style={{padding: '25px 44px 0'}}>{children}</div>
  </div>
);

/** A value written today, from either door; `at` is the frame it lands in the matrix. */
export type LiveCell = {metric: string; value: number; at: number};

/** The results matrix, rows fading in from `f`. Built from the fictional record only. */
export const ResultsMatrix: React.FC<{f: number; colW: number; live?: LiveCell[]}> = ({f, colW, live}) => {
  const dates = live ? [...DATES, TODAY] : DATES;
  return (
  <>
    <div style={{display: 'flex', alignItems: 'baseline', gap: 16, marginBottom: 18}}>
      <div style={{fontSize: 30, fontWeight: 700, color: T.ink}}>Your results</div>
      <div style={{fontSize: 15, color: T.ink3}}>Illustration of the fictional demo record</div>
    </div>
    <div style={{display: 'grid', gridTemplateColumns: `260px repeat(${dates.length}, ${colW}px)`, fontSize: 17, borderTop: '1px solid #e6e9e8'}}>
      <div style={{padding: '10px 0', fontSize: 13, color: T.ink3, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.6}}>Metric</div>
      {dates.map((d) => (
        <div key={d} style={{padding: '10px 0', fontSize: 13, color: d === TODAY ? T.accent : T.ink3, fontWeight: 600, textAlign: 'right'}}>
          {d === TODAY ? 'Today' : fmt(d)}
        </div>
      ))}
      {METRICS.map((m, i) => {
        const o = fadeIn(f, 8 + i * 3, 8);
        return (
          <React.Fragment key={m}>
            <div style={{padding: '9px 0', borderTop: '1px solid #eef0ef', color: T.ink, opacity: o}}>
              {LABEL[m][0]} <span style={{color: T.ink3, fontSize: 13}}>{LABEL[m][1]}</span>
            </div>
            {dates.map((d) => {
              const l = d === TODAY ? live?.find((x) => x.metric === m) : undefined;
              const shown = l && f >= l.at;
              const c = shown ? l : cells.find((x) => x.metric === m && x.date === d);
              const flash = l ? interpolate(f, [l.at, l.at + 6, l.at + 60], [0, 0.9, 0], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'}) : 0;
              return (
                <div
                  key={d}
                  style={{
                    padding: '9px 0',
                    borderTop: '1px solid #eef0ef',
                    textAlign: 'right',
                    opacity: o,
                    color: c ? T.ink : '#c8cdcc',
                    background: `rgba(14,143,111,${0.16 * flash})`,
                    fontWeight: shown ? 600 : 400,
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {c ? c.value : '·'}
                </div>
              );
            })}
          </React.Fragment>
        );
      })}
    </div>
  </>
  );
};

/** Beat 6: a stylised, clearly-mock results matrix of the fictional record on the website. */
export const Website: React.FC<{frame: number; from: number; to: number; fps: number}> = ({frame, from, to, fps}) => {
  if (frame < from - 1 || frame > to + 12) return null;
  const f = frame - from;
  const overlayAt = 80;
  const pop = spring({frame: f - overlayAt, fps, config: {damping: 200, mass: 0.7, stiffness: 110}});
  const colW = 150;
  return (
    <AbsoluteFill style={{background: '#e9edec', fontFamily: T.font, opacity: between(frame, from, to + 10, 10)}}>
      <BrowserFrame url="drstanfield.com/pages/roadmap">
        <ResultsMatrix f={f} colW={colW} />
      </BrowserFrame>
      {/* overlay */}
      <div style={{position: 'absolute', inset: 0, background: `rgba(23,36,34,${0.5 * pop})`}} />
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: 380,
          textAlign: 'center',
          color: '#fff',
          fontSize: 78,
          fontWeight: 700,
          letterSpacing: -1,
          opacity: pop,
          transform: `translateY(${interpolate(pop, [0, 1], [24, 0])}px)`,
          textShadow: '0 4px 30px rgba(0,0,0,0.35)',
        }}
      >
        Same file. Same record.
      </div>
    </AbsoluteFill>
  );
};

// --- Beat 7 of Video A: the same record through both doors -------------------
// One 21 s beat in three cuts: the site, the chat, the site again. The frames below
// are relative to the beat start and pinned to the caption chunks in timing.ts.
const SITE_A_TO = 262;
const CHAT_AT = 254;
const CHAT_TO = 448;
const SITE_B_AT = 440;
const TYPE_AT = 110;
const CLICK_AT = 180;
const WEIGHT_AT = 188; // the typed weight lands in today's column
const RELOAD_AT = 10; // frames into the second cut
const BP_AT = 55;
const OVERLAY_AT = 95;
/** The add-a-value row, laid out left to right; the cursor aims at the Save button. */
const ROW = {label: 210, input: 150, unit: 40, save: 100, gap: 14, h: 46};
const SAVE_X = CONTENT_L + ROW.label + ROW.gap + ROW.input + ROW.gap + ROW.unit + ROW.gap + ROW.save / 2;

const NEW_WEIGHT = 91.2;
const SYSTOLIC = 118;
const DIASTOLIC = 76;

/** The site's add-a-value row: an input the weight is typed into, and a Save button. */
const AddValue: React.FC<{f: number; typeAt: number | null; clickAt: number | null}> = ({f, typeAt, clickAt}) => {
  const text = String(NEW_WEIGHT);
  const typed = typeAt === null ? '' : text.slice(0, Math.max(0, Math.min(text.length, Math.floor((f - typeAt) / 11) + 1)));
  const focused = typeAt !== null && f >= typeAt - 20;
  const caret = focused && Math.floor(f / 15) % 2 === 0 ? '|' : '';
  const pressed = clickAt === null ? 0 : interpolate(f, [clickAt, clickAt + 5, clickAt + 16], [0, 1, 0], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
  return (
    <div style={{display: 'flex', alignItems: 'center', marginBottom: 26, opacity: fadeIn(f, 60, 12)}}>
      <div style={{width: ROW.label, fontSize: 17, color: T.ink2}}>Today's weight</div>
      <div
        style={{
          width: ROW.input,
          height: ROW.h,
          marginLeft: ROW.gap,
          boxSizing: 'border-box',
          border: `1px solid ${focused ? T.accent : '#d9dedd'}`,
          boxShadow: focused ? `0 0 0 3px rgba(14,143,111,0.14)` : 'none',
          borderRadius: 10,
          display: 'flex',
          alignItems: 'center',
          padding: '0 14px',
          fontSize: 19,
          color: T.ink,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {typed}
        <span style={{color: T.accent}}>{caret}</span>
      </div>
      <div style={{width: ROW.unit, marginLeft: ROW.gap, fontSize: 17, color: T.ink3}}>kg</div>
      <div
        style={{
          width: ROW.save,
          height: ROW.h,
          marginLeft: ROW.gap,
          boxSizing: 'border-box',
          borderRadius: 10,
          background: T.accent,
          color: '#fff',
          fontSize: 17,
          fontWeight: 600,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          transform: `scale(${1 - pressed * 0.05})`,
          filter: `brightness(${1 - pressed * 0.12})`,
        }}
      >
        Save
      </div>
    </div>
  );
};

/** One cut of the website: the add-a-value row and the matrix, today's column live. */
const SitePage: React.FC<{f: number; live: LiveCell[]; typeAt: number | null; clickAt: number | null; reload?: number}> = ({
  f,
  live,
  typeAt,
  clickAt,
  reload = 0,
}) => (
  <AbsoluteFill style={{background: '#e9edec', fontFamily: T.font}}>
    <BrowserFrame url="drstanfield.com/pages/roadmap" reload={reload}>
      <AddValue f={f} typeAt={typeAt} clickAt={clickAt} />
      <ResultsMatrix f={f} colW={132} live={live} />
    </BrowserFrame>
  </AbsoluteFill>
);

const CHAT_SCALE = SCENE_H / STAGE_H;
const CHAT_STAGE_W = Math.round(1920 / CHAT_SCALE);
const CHAT_TITLE = "Today's numbers";

/**
 * The other door. The assistant reads the weight the website just wrote, then writes a
 * blood pressure of its own. Short enough that nothing has to scroll.
 */
const SyncChat: React.FC<{f: number; fps: number}> = ({f, fps}) => (
  <AbsoluteFill style={{background: T.bg}}>
    <AbsoluteFill style={{width: CHAT_STAGE_W, height: STAGE_H, transform: `scale(${CHAT_SCALE})`, transformOrigin: 'top left', background: T.bg}}>
      <Sidebar title={CHAT_TITLE} />
      <div
        style={{
          position: 'absolute',
          left: SIDEBAR_W + (CHAT_STAGE_W - SIDEBAR_W - COL_W) / 2,
          bottom: 130, // the thread sits above the composer, the way a short chat does
          width: COL_W,
        }}
      >
        <UserBubble text="What is my latest weight?" frame={f} at={8} fps={fps} />
        <ToolRow tool="read_record" args="weight" frame={f} at={36} fps={fps} spinFrames={24} />
        <StreamText frame={f} at={66} text={`${NEW_WEIGHT} kg, recorded today. That is the value on the website, read straight from your file.`} />
        <UserBubble text={`Add today's blood pressure, ${SYSTOLIC} over ${DIASTOLIC}.`} frame={f} at={110} fps={fps} />
        <ToolRow tool="add_measurement" args={`${SYSTOLIC}/${DIASTOLIC} mmHg · today`} frame={f} at={140} fps={fps} spinFrames={24} />
        <StreamText frame={f} at={168} text="Saved. Your record now holds today's weight and today's blood pressure." />
      </div>
      <Header title={CHAT_TITLE} />
      <Composer width={COL_W} left={SIDEBAR_W + (CHAT_STAGE_W - SIDEBAR_W - COL_W) / 2} />
    </AbsoluteFill>
  </AbsoluteFill>
);

/**
 * Video A beat 7: the website and the chat writing to the same file, in that order.
 * Nothing here is a copy of the record; both cuts read the one fictional record.json.
 */
export const WebsiteSync: React.FC<{frame: number; from: number; to: number; fps: number}> = ({frame, from, to, fps}) => {
  if (frame < from - 1 || frame > to + 12) return null;
  const f = frame - from;
  const g = f - SITE_B_AT;
  const pop = spring({frame: g - OVERLAY_AT, fps, config: {damping: 200, mass: 0.7, stiffness: 110}});
  const weight: LiveCell = {metric: 'weight', value: NEW_WEIGHT, at: WEIGHT_AT};
  return (
    <AbsoluteFill style={{background: '#e9edec', opacity: between(frame, from, to + 10, 10)}}>
      <AbsoluteFill style={{opacity: between(f, 0, SITE_A_TO, 10)}}>
        <SitePage f={f} live={[weight]} typeAt={TYPE_AT} clickAt={CLICK_AT} />
        <Cursor
          frame={f}
          keys={[
            {at: TYPE_AT - 10, x: CONTENT_L + ROW.label + ROW.gap + ROW.input / 2, y: CONTENT_T + ROW.h / 2},
            {at: CLICK_AT - 6, x: SAVE_X, y: CONTENT_T + ROW.h / 2},
          ]}
          clicks={[CLICK_AT]}
          show={[TYPE_AT - 24, CLICK_AT + 20]}
        />
      </AbsoluteFill>
      <AbsoluteFill style={{opacity: between(f, CHAT_AT, CHAT_TO, 10)}}>
        <SyncChat f={f - CHAT_AT} fps={fps} />
      </AbsoluteFill>
      <AbsoluteFill style={{opacity: fadeIn(f, SITE_B_AT, 10)}}>
        <SitePage
          f={g}
          live={[
            {...weight, at: 0},
            {metric: 'systolic_bp', value: SYSTOLIC, at: BP_AT},
            {metric: 'diastolic_bp', value: DIASTOLIC, at: BP_AT + 8},
          ]}
          typeAt={null}
          clickAt={null}
          reload={interpolate(g, [RELOAD_AT, RELOAD_AT + 30], [0.02, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'})}
        />
      </AbsoluteFill>
      <div style={{position: 'absolute', inset: 0, background: `rgba(23,36,34,${0.5 * pop})`}} />
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: 380,
          textAlign: 'center',
          color: '#fff',
          fontFamily: T.font,
          fontSize: 78,
          fontWeight: 700,
          letterSpacing: -1,
          opacity: pop,
          transform: `translateY(${interpolate(pop, [0, 1], [24, 0])}px)`,
          textShadow: '0 4px 30px rgba(0,0,0,0.35)',
        }}
      >
        Two doors, one record.
      </div>
    </AbsoluteFill>
  );
};

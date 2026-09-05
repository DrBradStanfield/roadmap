import React, {useLayoutEffect, useRef, useState} from 'react';
import {
  AbsoluteFill,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  Easing,
  delayRender,
  continueRender,
} from 'remotion';
import {T, COL_W, SIDEBAR_W, HEADER_H, STAGE_W, STAGE_H} from './theme';
import {Sidebar, Header, Composer} from './Chrome';
import {UserBubble, ToolRow, StreamText, Card, Refs, Pill, FileChip, ResultsTable, ResultRow} from './blocks';
import {ApobChart} from './Chart';
import data from './plan-data.json';

// Beats A and B (import flows) lead; the original ApoB beats follow, shifted by OFF.
const OFF = 440;
const CUE = {
  fA: 8,
  uA: 12,
  tA: 30,
  aA: 68,
  cA: 88,
  aA2: 140,
  uA2: 184,
  tA2: 200,
  aA3: 236,
  uB: 288,
  tB: 306,
  aB: 344,
  cB: 364,
  aB2: 396,
  u1: 8 + OFF,
  t1: 26 + OFF,
  a1: 54 + OFF,
  c1: 118 + OFF,
  u2: 200 + OFF,
  t2: 218 + OFF,
  a2: 244 + OFF,
  c2: 254 + OFF,
  u3: 402 + OFF,
  t3: 420 + OFF,
  a3: 446 + OFF,
  c3a: 462 + OFF,
  c3b: 482 + OFF,
  c3c: 502 + OFF,
  note: 524 + OFF,
};

const ORDER: (keyof typeof CUE)[] = [
  'fA', 'uA', 'tA', 'aA', 'cA', 'aA2', 'uA2', 'tA2', 'aA3', 'uB', 'tB', 'aB', 'cB', 'aB2',
  'u1', 't1', 'a1', 'c1', 'u2', 't2', 'a2', 'c2', 'u3', 't3', 'a3', 'c3a', 'c3b', 'c3c', 'note',
];

// Fictional file names and counts. Status wording mirrors the real import_documents
// result: per-file status (extracted / already_imported), candidate slot state
// (free / held_equal / held_different) and documents[] for filed letters.
const ROWS_A: ResultRow[] = [
  {file: 'Labs 2026-06-14.pdf', status: '12 values, 3 new', tone: 'new'},
  {file: 'Lipid panel 2025-11-02.pdf', status: '8 values, already recorded', tone: 'same'},
  {file: 'Renal clinic letter.pdf', status: 'Clinic letter, filed', tone: 'filed'},
  {file: 'Labs 2024-02-11.pdf', status: '1 value differs', tone: 'differ'},
];
const ROWS_B: ResultRow[] = [
  {file: 'Labs 2026-08-20.pdf', status: '10 values, 10 new', tone: 'new'},
  {file: 'MRI report.pdf', status: 'Filed', tone: 'filed'},
];

const VIEW_H = STAGE_H - HEADER_H; // scroll viewport
const KEEP_H = 520; // area kept clear of the composer

const firstPara = (s: string) => s.split('\n\n')[0];

// Long guideline URLs are shown as their host; DOIs are short enough to show whole.
const srcUrl = (u: string) => {
  const bare = u.replace('https://', '');
  return bare.length <= 46 ? bare : bare.split('/')[0].replace('www.', '');
};

export const ApobDemo: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const contentRef = useRef<HTMLDivElement>(null);
  const refs = useRef<Record<string, HTMLDivElement | null>>({});
  const [box, setBox] = useState<Record<string, {top: number; h: number}> | null>(null);
  const [handle] = useState(() => delayRender('measure chat layout'));

  useLayoutEffect(() => {
    const root = contentRef.current;
    if (!root) return;
    // offsetTop/offsetHeight are layout px, immune to the stage's scale() transform.
    const next: Record<string, {top: number; h: number}> = {};
    for (const key of ORDER) {
      const el = refs.current[key];
      if (!el) continue;
      next[key] = {top: el.offsetTop, h: el.offsetHeight};
    }
    setBox(next);
    continueRender(handle);
  }, [handle]);

  // Scroll: analytic, from measured (static) block geometry. Heights never change,
  // because every block is always in the DOM and only opacity/transform animate.
  let scroll = 0;
  if (box) {
    const contentH = contentRef.current?.scrollHeight ?? 0;
    const maxScroll = Math.max(0, contentH - VIEW_H);
    const targetOf = (k: string) => {
      const b = box[k];
      if (!b) return 0;
      const t = b.h > KEEP_H - 40 ? b.top - 16 : b.top + b.h + 28 - KEEP_H;
      return Math.min(maxScroll, Math.max(0, t));
    };
    const cues = ORDER.filter((k) => frame >= CUE[k]);
    const k = cues.length - 1;
    if (k >= 0) {
      const from = k === 0 ? 0 : targetOf(ORDER[k - 1]);
      const to = targetOf(ORDER[k]);
      const start = CUE[ORDER[k]];
      scroll = interpolate(frame, [start, start + 22], [from, to], {
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
        easing: Easing.bezier(0.33, 0, 0.15, 1),
      });
    }
  }

  const set = (k: string) => (el: HTMLDivElement | null) => {
    refs.current[k] = el;
  };

  const b2 = data.beat2;

  return (
    <AbsoluteFill style={{background: T.bg}}>
      <AbsoluteFill
        style={{
          width: STAGE_W,
          height: STAGE_H,
          transform: `scale(${1920 / STAGE_W})`,
          transformOrigin: 'top left',
          background: T.bg,
        }}
      >
        <Sidebar />

        {/* chat viewport */}
        <div
          style={{
            position: 'absolute',
            left: SIDEBAR_W,
            top: HEADER_H,
            width: STAGE_W - SIDEBAR_W,
            height: VIEW_H,
            overflow: 'hidden',
          }}
        >
          <div
            ref={contentRef}
            style={{
              position: 'absolute',
              left: (STAGE_W - SIDEBAR_W - COL_W) / 2,
              top: 0,
              width: COL_W,
              transform: `translateY(${-scroll}px)`,
              willChange: 'transform',
            }}
          >
            {/* ---------- beat A: drag route ---------- */}
            <div ref={set('fA')}>
              <FileChip name="health.zip" meta="Zip archive · 2.3 MB" frame={frame} at={CUE.fA} fps={fps} />
            </div>
            <div ref={set('uA')}>
              <UserBubble text="Import this file into my health record." frame={frame} at={CUE.uA} fps={fps} style={{margin: '8px 0 4px'}} />
            </div>
            <div ref={set('tA')}>
              <ToolRow tool="import_documents" args="file: health.zip" frame={frame} at={CUE.tA} fps={fps} spinFrames={30} />
            </div>
            <div ref={set('aA')}>
              <StreamText frame={frame} at={CUE.aA} text="I read the four files in the zip. Nothing is saved yet." />
            </div>
            <div ref={set('cA')}>
              <ResultsTable rows={ROWS_A} frame={frame} at={CUE.cA} fps={fps} />
            </div>
            <div ref={set('aA2')}>
              <StreamText frame={frame} at={CUE.aA2} text="Save the 3 new values and file the letter?" />
            </div>
            <div ref={set('uA2')}>
              <UserBubble text="Yes" frame={frame} at={CUE.uA2} fps={fps} />
            </div>
            <div ref={set('tA2')}>
              <ToolRow tool="import_documents" args="commit" frame={frame} at={CUE.tA2} fps={fps} />
            </div>
            <div ref={set('aA3')}>
              <StreamText frame={frame} at={CUE.aA3} text="Saved 3 values and 1 letter to your health record." />
            </div>

            {/* ---------- beat B: folder route ---------- */}
            <div ref={set('uB')}>
              <UserBubble
                text="Import the lab files in my Health by Dr Brad folder in Dropbox."
                frame={frame}
                at={CUE.uB}
                fps={fps}
              />
            </div>
            <div ref={set('tB')}>
              <ToolRow tool="import_documents" args="route: folder" frame={frame} at={CUE.tB} fps={fps} spinFrames={30} />
            </div>
            <div ref={set('aB')}>
              <StreamText frame={frame} at={CUE.aB} text="Two files in that folder are new to your record." />
            </div>
            <div ref={set('cB')}>
              <ResultsTable rows={ROWS_B} frame={frame} at={CUE.cB} fps={fps} />
            </div>
            <div ref={set('aB2')}>
              <StreamText frame={frame} at={CUE.aB2} text="Nothing has been saved yet. Want me to save them?" />
            </div>

            {/* ---------- beat 1 ---------- */}
            <div ref={set('u1')}>
              <UserBubble text="what's the trend in my ApoB?" frame={frame} at={CUE.u1} fps={fps} />
            </div>
            <div ref={set('t1')}>
              <ToolRow tool="read_record" args="metric: apob" frame={frame} at={CUE.t1} fps={fps} />
            </div>
            <div ref={set('a1')}>
              <StreamText
                frame={frame}
                at={CUE.a1}
                text="Your ApoB has come down steadily since February 2024, from 1.28 to 0.92 g/L. It is still above the target your plan uses, so there is room to keep going."
              />
            </div>
            <div ref={set('c1')}>
              <Card frame={frame} at={CUE.c1} fps={fps} style={{padding: '18px 20px 14px'}}>
                <div style={{display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 4}}>
                  <div style={{fontSize: 15.5, fontWeight: 600, color: T.ink}}>ApoB</div>
                  <div style={{fontSize: 13, color: T.ink3}}>5 readings · g/L · SI units</div>
                </div>
                <ApobChart
                  series={data.apobSeries}
                  progress={interpolate(frame, [CUE.c1 + 4, CUE.c1 + 52], [0, 1], {
                    extrapolateLeft: 'clamp',
                    extrapolateRight: 'clamp',
                  })}
                />
              </Card>
            </div>

            {/* ---------- beat 2 ---------- */}
            <div ref={set('u2')}>
              <UserBubble
                text="What does my plan say to reduce my ApoB?"
                frame={frame}
                at={CUE.u2}
                fps={fps}
              />
            </div>
            <div ref={set('t2')}>
              <ToolRow tool="get_plan" frame={frame} at={CUE.t2} fps={fps} />
            </div>
            <div ref={set('a2')}>
              <StreamText
                frame={frame}
                at={CUE.a2}
                text="Here is the ApoB suggestion from your plan, in the plan's own words."
              />
            </div>
            <div ref={set('c2')}>
              <Card frame={frame} at={CUE.c2} fps={fps}>
                <div style={{display: 'flex', alignItems: 'center', gap: 10, marginBottom: 9}}>
                  <Pill tone="amber">Attention</Pill>
                  <div style={{fontSize: 12.5, color: T.ink3}}>medication</div>
                </div>
                <div style={{fontSize: 18, fontWeight: 600, color: T.ink, marginBottom: 7}}>
                  {b2.title}
                </div>
                <div style={{fontSize: 15, lineHeight: '24px', color: T.ink}}>{b2.description}</div>
                <div
                  style={{
                    marginTop: 12,
                    fontSize: 14,
                    lineHeight: '22px',
                    color: T.ink2,
                    borderLeft: `2px solid ${T.line}`,
                    paddingLeft: 12,
                  }}
                >
                  {b2.reason}
                </div>
                <div style={{display: 'flex', gap: 7, marginTop: 12}}>
                  {b2.guidelines.map((g) => (
                    <Pill key={g}>{g}</Pill>
                  ))}
                </div>
                <Refs refs={b2.references} />
                <div style={{marginTop: 11, fontSize: 13, color: T.ink2}}>
                  Full plan: <span style={{color: T.accent}}>{data.planLink.replace('https://', '')}</span>
                </div>
              </Card>
            </div>

            {/* ---------- beat 3 ---------- */}
            <div ref={set('u3')}>
              <UserBubble
                text="based on my medical record, what other suggestions are there to improve my health?"
                frame={frame}
                at={CUE.u3}
                fps={fps}
              />
            </div>
            <div ref={set('t3')}>
              <ToolRow tool="get_plan" frame={frame} at={CUE.t3} fps={fps} />
            </div>
            <div ref={set('a3')}>
              <StreamText
                frame={frame}
                at={CUE.a3}
                text="Three more from the same plan. Each carries the reason behind it and the paper it rests on."
              />
            </div>
            {data.beat3.map((s, i) => {
              const key = ['c3a', 'c3b', 'c3c'][i] as keyof typeof CUE;
              return (
                <div ref={set(key)} key={s.id}>
                  <Card frame={frame} at={CUE[key]} fps={fps} style={{padding: '17px 20px'}}>
                    <div style={{display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8}}>
                      <Pill tone={s.priority === 'attention' ? 'amber' : 'grey'}>{s.priority}</Pill>
                      <div style={{fontSize: 17, fontWeight: 600, color: T.ink}}>{s.title}</div>
                    </div>
                    <div style={{fontSize: 14.5, lineHeight: '23px', color: T.ink}}>
                      {firstPara(s.description)}
                    </div>
                    <div style={{marginTop: 9, fontSize: 12.5, lineHeight: '19px', color: T.ink2}}>
                      {s.references[0].label}{' '}
                      <span style={{color: T.accent}}>{srcUrl(s.references[0].url)}</span>
                    </div>
                  </Card>
                </div>
              );
            })}
            <div ref={set('note')}>
              <div
                style={{
                  marginTop: 16,
                  fontSize: 13.5,
                  color: T.ink3,
                  fontFamily: T.font,
                  opacity: interpolate(frame, [CUE.note, CUE.note + 12], [0, 1], {
                    extrapolateLeft: 'clamp',
                    extrapolateRight: 'clamp',
                  }),
                }}
              >
                This is educational, not medical advice. Take it to your doctor.
              </div>
            </div>
            <div style={{height: 190}}>&nbsp;</div>
          </div>
        </div>

        <Header />
        <Composer width={COL_W} left={SIDEBAR_W + (STAGE_W - SIDEBAR_W - COL_W) / 2} />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

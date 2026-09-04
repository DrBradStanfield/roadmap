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
import {UserBubble, ToolRow, StreamText, Card, Refs, Pill} from './blocks';
import {ApobChart} from './Chart';
import data from './plan-data.json';

const CUE = {
  u1: 8,
  t1: 26,
  a1: 54,
  c1: 118,
  u2: 200,
  t2: 218,
  a2: 244,
  c2: 254,
  u3: 402,
  t3: 420,
  a3: 446,
  c3a: 462,
  c3b: 482,
  c3c: 502,
  note: 524,
};

const ORDER: (keyof typeof CUE)[] = [
  'u1', 't1', 'a1', 'c1', 'u2', 't2', 'a2', 'c2', 'u3', 't3', 'a3', 'c3a', 'c3b', 'c3c', 'note',
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

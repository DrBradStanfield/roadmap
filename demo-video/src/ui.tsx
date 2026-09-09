import React from 'react';
import {interpolate, Easing} from 'remotion';
import {T} from './theme';
import {CAPTIONS, Timing} from './timing';

export const CAPTION_H = 150; // bottom band; scenes keep their content above it
export const SCENE_H = 1080 - CAPTION_H;

export const fadeIn = (frame: number, at: number, len = 10) =>
  interpolate(frame, [at, at + len], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
export const fadeOut = (frame: number, at: number, len = 10) =>
  interpolate(frame, [at - len, at], [1, 0], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
export const between = (frame: number, from: number, to: number, len = 10) =>
  Math.min(fadeIn(frame, from, len), fadeOut(frame, to, len));

/** Burned-in caption band. One chunk at a time, crossfaded, at most two lines. */
export const Captions: React.FC<{frame: number; t: Timing}> = ({frame, t}) => {
  const chunks = CAPTIONS.filter((c) => t.website || c.beat !== 6).map((c, i, all) => {
    const at = t.start[c.beat] + Math.round(c.at * 30);
    const next = all[i + 1];
    const end = next ? t.start[next.beat] + Math.round(next.at * 30) : t.start[c.beat + 1];
    return {...c, at, end};
  });
  const cur = chunks.find((c) => frame >= c.at && frame < c.end);
  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        height: CAPTION_H,
        background: '#141a19',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: T.font,
        zIndex: 20,
      }}
    >
      {cur ? (
        <div
          style={{
            opacity: between(frame, cur.at, cur.end, 6),
            color: '#fff',
            fontSize: 38,
            lineHeight: '50px',
            fontWeight: 500,
            textAlign: 'center',
            padding: '0 80px',
            letterSpacing: 0.1,
            textShadow: '0 1px 2px rgba(0,0,0,0.4)',
          }}
        >
          {cur.lines.map((l, i) => (
            <div key={i}>{l}</div>
          ))}
        </div>
      ) : null}
    </div>
  );
};

export type CursorKey = {at: number; x: number; y: number};

/** Arrow cursor easing between keyframes (stage px); `clicks` frames give a press pulse. */
export const Cursor: React.FC<{frame: number; keys: CursorKey[]; clicks?: number[]; show: [number, number]}> = ({
  frame,
  keys,
  clicks = [],
  show,
}) => {
  if (frame < show[0] || frame > show[1]) return null;
  const xs = keys.map((k) => k.x);
  const ys = keys.map((k) => k.y);
  const ats = keys.map((k) => k.at);
  const ease = {easing: Easing.bezier(0.3, 0, 0.2, 1), extrapolateLeft: 'clamp' as const, extrapolateRight: 'clamp' as const};
  const x = keys.length > 1 ? interpolate(frame, ats, xs, ease) : xs[0];
  const y = keys.length > 1 ? interpolate(frame, ats, ys, ease) : ys[0];
  const press = clicks.reduce((m, c) => Math.max(m, interpolate(frame, [c, c + 4, c + 10], [0, 1, 0], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'})), 0);
  return (
    <div style={{position: 'absolute', left: x, top: y, zIndex: 15, opacity: between(frame, show[0], show[1], 6), pointerEvents: 'none'}}>
      <div
        style={{
          position: 'absolute',
          left: -18,
          top: -18,
          width: 36,
          height: 36,
          borderRadius: 99,
          background: 'rgba(0,163,139,0.28)',
          transform: `scale(${press})`,
        }}
      />
      <svg width="30" height="34" viewBox="0 0 24 28" style={{transform: `scale(${1 - press * 0.12})`, display: 'block'}}>
        <path d="M3 2l17 13-7.5 1.2L17 25l-3.5 1.5-4.5-8.6L3 22z" fill="#fff" stroke="#111" strokeWidth={1.6} strokeLinejoin="round" />
      </svg>
    </div>
  );
};

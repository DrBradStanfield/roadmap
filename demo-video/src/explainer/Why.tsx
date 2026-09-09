import React from 'react';
import {AbsoluteFill, interpolate, spring, staticFile, Img} from 'remotion';
import {T} from '../theme';
import {between, fadeIn, fadeOut, SCENE_H} from '../ui';

const G = {ground: '#f5f8f7', ink: '#172422', muted: '#5b6b68', line: '#d9e2df', accent: '#00a38b', accentInk: '#0b6f61'};

const LEFT = [
  'Read once, then forgotten when the chat ends',
  'Numbers guessed from a page',
  'Every new chat starts from nothing',
  'No protocol, no citations',
];
const RIGHT = [
  'Stored as structured data, updated whenever you add to it',
  'One file, owned only by you, in your Dropbox',
  'Every assistant, every chat, the same record',
  "Dr Brad's protocol, with the citations",
];

/** Beat 0: hook line alone, the two-column contrast row by row, then Brad's line held. */
export const Why: React.FC<{frame: number; from: number; to: number; fps: number}> = ({frame, from, to, fps}) => {
  if (frame < from - 1 || frame > to + 12) return null;
  const f = frame - from;
  const hookAlone = 60; // 2.0 s
  const colsOut = 225; // 7.5 s
  const rowAt = (i: number) => 72 + i * 36;
  // hook: centred and large, then lifts to a header as the columns arrive
  const lift = spring({frame: f - hookAlone, fps, config: {damping: 200, mass: 0.8, stiffness: 90}});
  const hookY = interpolate(lift, [0, 1], [SCENE_H / 2 - 60, 88]);
  const hookSize = interpolate(lift, [0, 1], [58, 40]);

  const row = (i: number) => {
    const s = spring({frame: f - rowAt(i), fps, config: {damping: 200, mass: 0.6, stiffness: 120}});
    return {opacity: fadeIn(f, rowAt(i), 8), y: interpolate(s, [0, 1], [14, 0])};
  };

  return (
    <AbsoluteFill style={{background: G.ground, fontFamily: T.font, opacity: fadeOut(frame, to + 10, 10)}}>
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: hookY,
          textAlign: 'center',
          fontSize: hookSize,
          lineHeight: 1.25,
          fontWeight: 700,
          color: G.ink,
          letterSpacing: -0.5,
          opacity: Math.min(fadeIn(f, 4, 12), fadeOut(f, colsOut + 10, 12)),
          padding: '0 200px',
        }}
      >
        Every new chat starts from nothing.
        <br />
        Your health record should not.
      </div>

      {/* two columns */}
      <div
        style={{
          position: 'absolute',
          left: 160,
          right: 160,
          top: 230,
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 40,
          opacity: Math.min(fadeIn(f, hookAlone + 8, 10), fadeOut(f, colsOut + 10, 12)),
        }}
      >
        <div style={{background: '#eceff0', border: `1px solid ${G.line}`, borderRadius: 20, padding: '30px 36px'}}>
          <div style={{fontSize: 30, fontWeight: 700, color: G.muted, marginBottom: 22}}>Paste a PDF into a chatbot</div>
          {LEFT.map((t, i) => (
            <div key={t} style={{display: 'flex', gap: 16, alignItems: 'flex-start', margin: '16px 0', opacity: row(i).opacity, transform: `translateY(${row(i).y}px)`}}>
              <span style={{width: 12, height: 12, borderRadius: 99, background: '#9aa5a3', marginTop: 14, flexShrink: 0}} />
              <span style={{fontSize: 30, lineHeight: '40px', color: G.muted}}>{t}</span>
            </div>
          ))}
        </div>
        <div style={{background: '#fff', border: `2px solid ${G.accent}`, borderRadius: 20, padding: '30px 36px', boxShadow: '0 10px 40px rgba(0,163,139,0.12)'}}>
          <div style={{display: 'flex', alignItems: 'center', gap: 14, fontSize: 30, fontWeight: 700, color: G.accentInk, marginBottom: 22}}>
            <Img src={staticFile('app-icon.png')} style={{width: 40, height: 40, borderRadius: 10}} />
            Health by Dr Brad
          </div>
          {RIGHT.map((t, i) => (
            <div key={t} style={{display: 'flex', gap: 16, alignItems: 'flex-start', margin: '16px 0', opacity: row(i).opacity, transform: `translateY(${row(i).y}px)`}}>
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke={G.accent} strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" style={{marginTop: 8, flexShrink: 0}}>
                <path d="M20 6L9 17l-5-5" />
              </svg>
              <span style={{fontSize: 30, lineHeight: '40px', color: G.ink}}>{t}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Brad's line */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: SCENE_H / 2 - 80,
          textAlign: 'center',
          padding: '0 260px',
          opacity: between(frame, from + colsOut + 12, to + 10, 12),
        }}
      >
        <Img src={staticFile('app-icon.png')} style={{width: 72, height: 72, borderRadius: 18, marginBottom: 26}} />
        <div style={{fontSize: 50, lineHeight: 1.3, fontWeight: 700, color: G.ink, letterSpacing: -0.5}}>
          Your health data, owned only by you in your own Dropbox, understood by your AI assistant.
        </div>
      </div>
    </AbsoluteFill>
  );
};

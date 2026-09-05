import React from 'react';
import {interpolate, spring, Easing, staticFile, Img} from 'remotion';
import {T} from './theme';

export const enter = (frame: number, at: number, fps: number) => {
  const s = spring({frame: frame - at, fps, config: {damping: 200, mass: 0.6, stiffness: 120}});
  return {opacity: interpolate(frame - at, [0, 8], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'}), s};
};

export const UserBubble: React.FC<{text: string; frame: number; at: number; fps: number; style?: React.CSSProperties}> = ({
  text,
  frame,
  at,
  fps,
  style,
}) => {
  const {opacity, s} = enter(frame, at, fps);
  const scale = interpolate(s, [0, 1], [0.96, 1]);
  return (
    <div style={{display: 'flex', justifyContent: 'flex-end', margin: '30px 0 4px', ...style}}>
      <div
        style={{
          opacity,
          transform: `scale(${scale})`,
          transformOrigin: 'right bottom',
          background: T.bubble,
          color: T.ink,
          borderRadius: 22,
          padding: '11px 19px',
          fontSize: 17,
          lineHeight: '25px',
          maxWidth: '76%',
          fontFamily: T.font,
        }}
      >
        {text}
      </div>
    </div>
  );
};

export const ToolRow: React.FC<{
  tool: string;
  args?: string;
  frame: number;
  at: number;
  fps: number;
  spinFrames?: number;
}> = ({tool, args, frame, at, fps, spinFrames = 20}) => {
  const {opacity, s} = enter(frame, at, fps);
  const done = frame - at > spinFrames;
  const angle = ((frame - at) * 13) % 360;
  const checkIn = interpolate(frame - at, [spinFrames, spinFrames + 7], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  return (
    <div
      style={{
        opacity,
        transform: `translateY(${interpolate(s, [0, 1], [8, 0])}px)`,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 9,
        border: `1px solid ${T.line}`,
        background: '#fcfcfc',
        borderRadius: 12,
        padding: '8px 14px',
        margin: '22px 0 0',
        fontFamily: T.font,
      }}
    >
      <Img src={staticFile('app-icon.png')} style={{width: 20, height: 20, borderRadius: 6}} />
      <span style={{fontSize: 14.5, color: T.ink, fontWeight: 500}}>Health by Dr Brad</span>
      <span style={{color: T.line}}>|</span>
      <span style={{fontSize: 14, color: T.ink2, fontFamily: T.mono}}>{tool}</span>
      {args ? <span style={{fontSize: 13.5, color: T.ink3, fontFamily: T.mono}}>{args}</span> : null}
      <span style={{display: 'flex', width: 16, height: 16, marginLeft: 3}}>
        {done ? (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={T.accent} strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 6L9 17l-5-5" strokeDasharray={30} strokeDashoffset={30 * (1 - checkIn)} />
          </svg>
        ) : (
          <svg width="16" height="16" viewBox="0 0 16 16" style={{transform: `rotate(${angle}deg)`}}>
            <circle cx="8" cy="8" r="6" fill="none" stroke={T.line} strokeWidth={2.4} />
            <path d="M8 2a6 6 0 0 1 6 6" fill="none" stroke={T.ink2} strokeWidth={2.4} strokeLinecap="round" />
          </svg>
        )}
      </span>
    </div>
  );
};

export const StreamText: React.FC<{
  text: string;
  frame: number;
  at: number;
  perWord?: number;
  style?: React.CSSProperties;
}> = ({text, frame, at, perWord = 2, style}) => {
  const words = text.split(' ');
  return (
    <div
      style={{
        fontSize: 17,
        lineHeight: '28px',
        color: T.ink,
        fontFamily: T.font,
        margin: '20px 0 0',
        ...style,
      }}
    >
      {words.map((w, i) => (
        <span
          key={i}
          style={{
            opacity: interpolate(frame, [at + i * perWord, at + i * perWord + 3], [0, 1], {
              extrapolateLeft: 'clamp',
              extrapolateRight: 'clamp',
            }),
          }}
        >
          {w}
          {i < words.length - 1 ? ' ' : ''}
        </span>
      ))}
    </div>
  );
};

export const Card: React.FC<{
  frame: number;
  at: number;
  fps: number;
  children: React.ReactNode;
  style?: React.CSSProperties;
}> = ({frame, at, fps, children, style}) => {
  const {opacity, s} = enter(frame, at, fps);
  return (
    <div
      style={{
        opacity,
        transform: `translateY(${interpolate(s, [0, 1], [12, 0])}px)`,
        border: `1px solid ${T.line}`,
        borderRadius: 16,
        background: T.card,
        padding: 20,
        margin: '16px 0 0',
        boxShadow: '0 1px 2px rgba(0,0,0,0.03)',
        fontFamily: T.font,
        ...style,
      }}
    >
      {children}
    </div>
  );
};

export const Refs: React.FC<{refs: {label: string; url: string}[]}> = ({refs}) => (
  <div style={{marginTop: 12, borderTop: `1px solid ${T.line}`, paddingTop: 11}}>
    {refs.map((r) => (
      <div key={r.url} style={{fontSize: 12.5, lineHeight: '19px', color: T.ink2, marginBottom: 3}}>
        {r.label}{' '}
        <span style={{color: T.accent}}>{r.url.replace('https://', '')}</span>
      </div>
    ))}
  </div>
);

export const Pill: React.FC<{children: React.ReactNode; tone?: 'amber' | 'grey'}> = ({
  children,
  tone = 'grey',
}) => (
  <span
    style={{
      fontSize: 11.5,
      letterSpacing: 0.3,
      textTransform: 'uppercase',
      color: tone === 'amber' ? T.amber : T.ink2,
      background: tone === 'amber' ? '#fdf3e7' : '#f2f2f2',
      borderRadius: 6,
      padding: '3px 8px',
      fontWeight: 600,
    }}
  >
    {children}
  </span>
);

/** Attached-file chip, shown above the user bubble the way a chat client renders an upload. */
export const FileChip: React.FC<{name: string; meta: string; frame: number; at: number; fps: number}> = ({
  name,
  meta,
  frame,
  at,
  fps,
}) => {
  const {opacity, s} = enter(frame, at, fps);
  return (
    <div style={{display: 'flex', justifyContent: 'flex-end', margin: '30px 0 0'}}>
      <div
        style={{
          opacity,
          transform: `scale(${interpolate(s, [0, 1], [0.96, 1])})`,
          transformOrigin: 'right bottom',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          border: `1px solid ${T.line}`,
          background: '#fff',
          borderRadius: 16,
          padding: '10px 16px 10px 12px',
          fontFamily: T.font,
        }}
      >
        <span
          style={{
            width: 36,
            height: 36,
            borderRadius: 9,
            background: T.accentSoft,
            color: T.accent,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
            <path d="M6 3h9l5 5v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" />
            <path d="M10 4v2M10 8v2M10 12v2M10 16v2" />
          </svg>
        </span>
        <span>
          <div style={{fontSize: 15, fontWeight: 600, color: T.ink, lineHeight: '20px'}}>{name}</div>
          <div style={{fontSize: 13, color: T.ink3, lineHeight: '18px'}}>{meta}</div>
        </span>
      </div>
    </div>
  );
};

export type ResultRow = {file: string; status: string; tone?: 'new' | 'same' | 'differ' | 'filed'};

const STATUS_COLOR = {new: T.accent, same: T.ink3, differ: T.amber, filed: T.ink2};

/** Compact File / Result table; rows stagger in after `at`. */
export const ResultsTable: React.FC<{rows: ResultRow[]; frame: number; at: number; fps: number}> = ({
  rows,
  frame,
  at,
  fps,
}) => (
  <Card frame={frame} at={at} fps={fps} style={{padding: '6px 20px 8px'}}>
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr 250px',
        gap: 12,
        padding: '10px 0 8px',
        borderBottom: `1px solid ${T.line}`,
        fontSize: 13,
        fontWeight: 600,
        color: T.ink2,
      }}
    >
      <div>File</div>
      <div>Result</div>
    </div>
    {rows.map((r, i) => {
      const {opacity, s} = enter(frame, at + 8 + i * 6, fps);
      return (
        <div
          key={r.file}
          style={{
            opacity,
            transform: `translateY(${interpolate(s, [0, 1], [6, 0])}px)`,
            display: 'grid',
            gridTemplateColumns: '1fr 250px',
            gap: 12,
            alignItems: 'center',
            padding: '9px 0',
            borderBottom: i < rows.length - 1 ? `1px solid ${T.line}` : 'none',
          }}
        >
          <div>
            <span
              style={{
                fontFamily: T.mono,
                fontSize: 13.5,
                color: T.ink,
                background: '#f2f2f2',
                borderRadius: 6,
                padding: '3px 8px',
                whiteSpace: 'nowrap',
              }}
            >
              {r.file}
            </span>
          </div>
          <div style={{fontSize: 14.5, color: STATUS_COLOR[r.tone ?? 'same']}}>{r.status}</div>
        </div>
      );
    })}
  </Card>
);

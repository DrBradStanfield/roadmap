import React from 'react';
import {AbsoluteFill, interpolate} from 'remotion';
import {T} from '../theme';
import {between, fadeIn} from '../ui';
import {ROWS} from './ChatScene';

const C = {ground: '#eef1f0', ink: '#172422', muted: '#5b6b68', line: '#e2e6e5', accent: '#00a38b'};

// The same fictional files the import table reports, as they sit in the folder.
const FILES = [
  ...ROWS.map((r, i) => ({name: r.file, meta: ['2.1 MB', '480 KB', '210 KB', '1.4 MB'][i], record: false})),
  {name: 'health-roadmap.json', meta: '86 KB', record: true},
];

const Icon: React.FC<{record: boolean}> = ({record}) => (
  <span
    style={{
      width: 40,
      height: 40,
      borderRadius: 10,
      flexShrink: 0,
      background: record ? '#e6f4f0' : '#f1f3f2',
      color: record ? C.accent : C.muted,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
    }}
  >
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 3h9l5 5v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" />
      <path d="M15 3v5h5" />
    </svg>
  </span>
);

/** Beat 2, first half: the cloud folder the assistant reads, with the record already in it. */
export const Folder: React.FC<{frame: number; from: number; to: number}> = ({frame, from, to}) => {
  if (frame < from - 1 || frame > to + 12) return null;
  const f = frame - from;
  return (
    <AbsoluteFill style={{background: C.ground, fontFamily: T.font, opacity: between(frame, from, to + 10, 10)}}>
      <div
        style={{
          position: 'absolute',
          left: 360,
          width: 1200,
          top: 215,
          background: '#fff',
          border: `1px solid ${C.line}`,
          borderRadius: 18,
          boxShadow: '0 14px 50px rgba(23,36,34,0.10)',
          overflow: 'hidden',
        }}
      >
        <div style={{height: 52, background: '#f6f8f7', borderBottom: `1px solid ${C.line}`, display: 'flex', alignItems: 'center', gap: 8, padding: '0 18px'}}>
          {['#fe5f57', '#febc2e', '#28c840'].map((c) => (
            <span key={c} style={{width: 12, height: 12, borderRadius: 99, background: c}} />
          ))}
          <span style={{margin: '0 auto', paddingRight: 36, fontSize: 16, color: C.muted}}>Dropbox</span>
        </div>
        <div style={{padding: '26px 34px 30px'}}>
          <div style={{fontSize: 18, color: C.muted, marginBottom: 22}}>
            Dropbox <span style={{color: '#b6c0bd'}}>/</span> Apps <span style={{color: '#b6c0bd'}}>/</span>{' '}
            <span style={{color: C.ink, fontWeight: 600}}>Health Plan by Dr Brad</span>
          </div>
          {FILES.map((file, i) => (
            <div
              key={file.name}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 18,
                padding: '13px 8px',
                borderTop: `1px solid ${C.line}`,
                opacity: fadeIn(f, 6 + i * 5, 8),
                transform: `translateY(${interpolate(fadeIn(f, 6 + i * 5, 8), [0, 1], [6, 0])}px)`,
              }}
            >
              <Icon record={file.record} />
              <span style={{fontSize: 21, color: C.ink, fontFamily: T.mono}}>{file.name}</span>
              {file.record ? (
                <span style={{fontSize: 14, fontWeight: 600, color: C.accent, background: '#e6f4f0', borderRadius: 8, padding: '4px 10px'}}>
                  your record
                </span>
              ) : null}
              <span style={{marginLeft: 'auto', fontSize: 17, color: '#93a09d'}}>{file.meta}</span>
            </div>
          ))}
        </div>
      </div>
    </AbsoluteFill>
  );
};

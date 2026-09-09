import React from 'react';
import {T} from '../theme';

export const REPO = 'github.com/DrBradStanfield/roadmap';

const TREE: [string, string][] = [
  ['packages/health-core/', 'the thresholds, the suggestions, the citations'],
  ['widget-src/', 'the website you see your results on'],
  ['app/', 'the connector server'],
  ['docs/', "Dr Brad's protocol, written out"],
];

const Pill: React.FC<{children: React.ReactNode}> = ({children}) => (
  <span
    style={{
      fontSize: '0.72em',
      letterSpacing: 0.3,
      fontWeight: 600,
      color: T.ink2,
      background: '#f2f2f2',
      border: `1px solid ${T.line}`,
      borderRadius: '0.5em',
      padding: '0.18em 0.55em',
    }}
  >
    {children}
  </span>
);

/**
 * A plain, unbranded repository card. Sized in em off `scale`, so the same card
 * serves a full-frame beat and a chat bubble.
 */
export const RepoCard: React.FC<{scale?: number; style?: React.CSSProperties}> = ({scale = 1, style}) => (
  <div
    style={{
      fontFamily: T.font,
      fontSize: 16 * scale,
      border: `1px solid ${T.line}`,
      borderRadius: '1em',
      background: T.card,
      padding: '1.4em 1.6em',
      boxShadow: '0 1px 2px rgba(0,0,0,0.03)',
      boxSizing: 'border-box',
      ...style,
    }}
  >
    <div style={{display: 'flex', alignItems: 'center', gap: '0.7em'}}>
      <svg width="1.5em" height="1.5em" viewBox="0 0 24 24" fill="none" stroke={T.ink2} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5z" />
        <path d="M4 17.5h16" />
      </svg>
      <span style={{fontFamily: T.mono, fontSize: '1.05em', color: T.ink, fontWeight: 500}}>{REPO}</span>
      <Pill>MIT</Pill>
      <Pill>Public</Pill>
    </div>
    <div style={{marginTop: '1.1em', borderTop: `1px solid ${T.line}`, paddingTop: '0.9em'}}>
      {TREE.map(([path, note]) => (
        <div key={path} style={{display: 'flex', alignItems: 'baseline', gap: '0.8em', padding: '0.28em 0'}}>
          <span style={{fontFamily: T.mono, fontSize: '0.9em', color: T.ink, minWidth: '13em'}}>{path}</span>
          <span style={{fontSize: '0.9em', color: T.ink2}}>{note}</span>
        </div>
      ))}
    </div>
    <div style={{marginTop: '1em', fontSize: '0.9em', color: T.ink2}}>
      Every rule, every threshold and every citation is in here, and anyone can read it.
    </div>
  </div>
);

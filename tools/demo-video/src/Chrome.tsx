import React from 'react';
import {staticFile, Img} from 'remotion';
import {T, SIDEBAR_W, HEADER_H} from './theme';

const Row: React.FC<{icon: React.ReactNode; label: string; active?: boolean}> = ({
  icon,
  label,
  active,
}) => (
  <div
    style={{
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      padding: '7px 10px',
      borderRadius: 9,
      background: active ? '#ececec' : 'transparent',
      color: T.ink,
      fontSize: 14,
      lineHeight: '18px',
      whiteSpace: 'nowrap',
    }}
  >
    <span style={{display: 'flex', width: 18, height: 18, color: T.ink2}}>{icon}</span>
    {label}
  </div>
);

const S = (p: {d: string}) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
    <path d={p.d} />
  </svg>
);

export const Sidebar: React.FC = () => (
  <div
    style={{
      position: 'absolute',
      left: 0,
      top: 0,
      width: SIDEBAR_W,
      height: '100%',
      background: T.sidebar,
      borderRight: `1px solid ${T.line}`,
      padding: '14px 10px',
      boxSizing: 'border-box',
      fontFamily: T.font,
    }}
  >
    <div style={{display: 'flex', justifyContent: 'space-between', padding: '2px 8px 14px'}}>
      <span style={{color: T.ink2}}>
        <S d="M3 5h18M3 5v14h18V5M9 5v14" />
      </span>
      <span style={{color: T.ink2}}>
        <S d="M12 4v16M4 12h16" />
      </span>
    </div>
    <Row icon={<S d="M12 5v14M5 12h14" />} label="New chat" />
    <Row icon={<S d="M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3" />} label="Search chats" />
    <Row icon={<S d="M4 5h10M4 12h10M4 19h16M18 5v6M15 8h6" />} label="Library" />
    <div style={{height: 18}} />
    <div style={{padding: '0 10px 8px', fontSize: 12, color: T.ink3, letterSpacing: 0.2}}>Apps</div>
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '7px 10px',
        borderRadius: 9,
        background: '#ececec',
        fontSize: 14,
        color: T.ink,
      }}
    >
      <Img src={staticFile('app-icon.png')} style={{width: 18, height: 18, borderRadius: 5}} />
      Health by Dr Brad
    </div>
    <div style={{height: 22}} />
    <div style={{padding: '0 10px 8px', fontSize: 12, color: T.ink3}}>Today</div>
    <Row icon={<span />} label="Import my lab files" active />
    <Row icon={<span />} label="Lab panel from June" />
    <Row icon={<span />} label="Sleep and blood pressure" />
  </div>
);

export const Header: React.FC = () => (
  <div
    style={{
      position: 'absolute',
      left: SIDEBAR_W,
      right: 0,
      top: 0,
      height: HEADER_H,
      display: 'flex',
      alignItems: 'center',
      padding: '0 22px',
      boxSizing: 'border-box',
      fontFamily: T.font,
      background: 'rgba(255,255,255,0.86)',
      backdropFilter: 'blur(6px)',
      zIndex: 5,
    }}
  >
    <div style={{display: 'flex', alignItems: 'center', gap: 5, fontSize: 15, color: T.ink}}>
      <span style={{fontWeight: 500}}>Auto</span>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={T.ink3} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <path d="M6 9l6 6 6-6" />
      </svg>
    </div>
    <div style={{flex: 1, textAlign: 'center', fontSize: 15, color: T.ink2}}>Import my lab files</div>
    <div
      style={{
        border: `1px solid ${T.line}`,
        borderRadius: 999,
        padding: '5px 14px',
        fontSize: 13,
        color: T.ink,
      }}
    >
      Share
    </div>
  </div>
);

export const Composer: React.FC<{width: number; left: number}> = ({width, left}) => (
  <div
    style={{
      position: 'absolute',
      left,
      bottom: 22,
      width,
      background: '#fff',
      border: `1px solid ${T.line}`,
      borderRadius: 26,
      boxShadow: '0 8px 26px rgba(0,0,0,0.06)',
      padding: '14px 16px 10px',
      boxSizing: 'border-box',
      fontFamily: T.font,
      zIndex: 4,
    }}
  >
    <div style={{fontSize: 15, color: T.ink3, padding: '2px 4px 14px'}}>Ask anything</div>
    <div style={{display: 'flex', alignItems: 'center'}}>
      <span style={{color: T.ink2, display: 'flex'}}>
        <S d="M12 5v14M5 12h14" />
      </span>
      <div style={{flex: 1}} />
      <span style={{color: T.ink2, display: 'flex', marginRight: 12}}>
        <S d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zM19 11a7 7 0 0 1-14 0M12 18v3" />
      </span>
      <div
        style={{
          width: 30,
          height: 30,
          borderRadius: 999,
          background: T.ink,
          color: '#fff',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 19V5M5 12l7-7 7 7" />
        </svg>
      </div>
    </div>
  </div>
);

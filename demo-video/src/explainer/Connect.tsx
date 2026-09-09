import React from 'react';
import {AbsoluteFill, interpolate} from 'remotion';
import {T} from '../theme';
import {between, Cursor} from '../ui';

const C = {ground: '#f5f5f4', ink: '#172422', muted: '#5b6b68', line: '#e4e7e6', accent: '#00a38b'};
const PANEL_W = 820;
const PANEL_L = (1920 - PANEL_W) / 2;
const PANEL_T = 34;

const Btn: React.FC<{label: string; glyph: React.ReactNode; top: number}> = ({label, glyph, top}) => (
  <div
    style={{
      position: 'absolute',
      left: 44,
      right: 44,
      top,
      height: 70,
      background: C.accent,
      borderRadius: 12,
      display: 'flex',
      alignItems: 'center',
      gap: 18,
      padding: '0 30px',
      color: '#fff',
      fontSize: 19,
      fontWeight: 500,
      boxSizing: 'border-box',
    }}
  >
    {glyph}
    {label}
  </div>
);

const CAN = [
  'Read your record and produce your plan.',
  'Add measurements and lab results.',
  'Correct a recent value. Nothing is ever deleted.',
  'Update your sex, birth year, birth month and height.',
  'File a bug report as a public issue on GitHub, in your words, without your health values, and without asking again.',
];

/** Beat 1: the consent page (recreated from the live capture), cursor to Dropbox, a blurred Dropbox permission screen. */
export const Connect: React.FC<{frame: number; from: number; to: number}> = ({frame, from, to}) => {
  if (frame < from - 1 || frame > to + 12) return null;
  const consentEnd = from + 120; // 4 s on the page
  const dropboxEnd = from + 180; // 2 s of Dropbox
  const btnY = PANEL_T + 372; // Dropbox button top, in frame px
  const clickAt = from + 100;
  return (
    <>
      <AbsoluteFill style={{background: C.ground, fontFamily: T.font, opacity: between(frame, from, consentEnd, 10)}}>
        <div style={{position: 'absolute', left: PANEL_L, top: PANEL_T - 2, display: 'flex', alignItems: 'center', gap: 10, fontSize: 18, color: C.muted}}>
          <span style={{width: 12, height: 12, borderRadius: 99, background: C.accent}} />
          Dr Brad Stanfield · Health by Dr Brad
        </div>
        <div
          style={{
            position: 'absolute',
            left: PANEL_L,
            top: PANEL_T + 40,
            width: PANEL_W,
            height: 1100,
            background: '#fff',
            border: `1px solid ${C.line}`,
            borderRadius: 18,
            boxShadow: '0 4px 24px rgba(0,0,0,0.05)',
          }}
        >
          <div style={{position: 'absolute', left: 44, right: 44, top: 40, fontSize: 40, lineHeight: 1.15, fontWeight: 700, color: C.ink, letterSpacing: -0.6}}>
            Where do you want to keep your health record?
          </div>
          <div style={{position: 'absolute', left: 44, right: 44, top: 150, fontSize: 21, color: C.muted}}>
            <b style={{color: C.ink, fontWeight: 600}}>ChatGPT</b> wants to connect to your health record.
          </div>
          <div style={{position: 'absolute', left: 44, right: 44, top: 196, fontSize: 21, lineHeight: '32px', color: C.muted}}>
            Your health record is yours, and yours alone. Keep it in your own Dropbox or Google Drive. Your assistant reads and writes one file there. Nothing is stored on our server.
          </div>
          <Btn
            top={332}
            label="Continue to Dropbox"
            glyph={
              <svg width="26" height="24" viewBox="0 0 26 24" fill="#fff">
                <path d="M6.5 1L0 5.2l6.5 4.2 6.5-4.2zM19.5 1L13 5.2l6.5 4.2L26 5.2zM0 13.6l6.5 4.2 6.5-4.2-6.5-4.2zM19.5 9.4L13 13.6l6.5 4.2 6.5-4.2zM6.5 19.2l6.5 4.2 6.5-4.2-6.5-4.2z" />
              </svg>
            }
          />
          <Btn
            top={420}
            label="Continue to Google Drive"
            glyph={
              <svg width="26" height="24" viewBox="0 0 26 24" fill="#fff">
                <path d="M8.7 0h8.6l8.7 15H17.3zM0 15l4.3-7.5 8.7 15H4.3zM5.3 24l4.3-7.5H26L21.7 24z" />
              </svg>
            }
          />
          <div style={{position: 'absolute', left: 44, top: 526, fontSize: 15, letterSpacing: 2, fontWeight: 600, color: C.muted}}>WHAT THE ASSISTANT CAN DO</div>
          {CAN.map((t, i) => (
            <div key={t} style={{position: 'absolute', left: 44, right: 44, top: 566 + i * 46, display: 'flex', gap: 16, fontSize: 21, lineHeight: '32px', color: C.ink}}>
              <span style={{width: 9, height: 9, borderRadius: 99, background: C.accent, marginTop: 12, flexShrink: 0}} />
              <span style={{whiteSpace: i === 4 ? 'normal' : 'nowrap'}}>{t}</span>
            </div>
          ))}
        </div>
        <Cursor
          frame={frame}
          keys={[
            {at: from + 30, x: 1320, y: 720},
            {at: from + 90, x: PANEL_L + 220, y: btnY + 36},
          ]}
          clicks={[clickAt]}
          show={[from + 24, consentEnd]}
        />
      </AbsoluteFill>

      {/* blurred Dropbox permission placeholder: generic shapes, no marks */}
      <AbsoluteFill style={{background: '#fff', opacity: between(frame, consentEnd, dropboxEnd, 8)}}>
        <div style={{position: 'absolute', inset: 0, filter: 'blur(16px)', transform: 'scale(1.02)'}}>
          <div style={{position: 'absolute', left: 0, right: 0, top: 0, height: 90, background: '#0061ff'}} />
          <div style={{position: 'absolute', left: 640, top: 190, width: 640, height: 620, background: '#f7f9fc', border: '1px solid #e2e6ee', borderRadius: 16}}>
            <div style={{position: 'absolute', left: 60, top: 60, width: 90, height: 90, borderRadius: 22, background: '#0061ff'}} />
            {[0, 1, 2, 3].map((i) => (
              <div key={i} style={{position: 'absolute', left: 60, top: 190 + i * 46, width: i % 2 ? 380 : 500, height: 22, borderRadius: 11, background: '#c9d1dc'}} />
            ))}
            <div style={{position: 'absolute', left: 60, top: 480, width: 220, height: 60, borderRadius: 12, background: '#0061ff'}} />
            <div style={{position: 'absolute', left: 310, top: 480, width: 220, height: 60, borderRadius: 12, background: '#dde3ec'}} />
          </div>
        </div>
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: 850,
            textAlign: 'center',
            fontFamily: T.font,
            fontSize: 26,
            color: '#3a4550',
            opacity: interpolate(frame, [consentEnd + 8, consentEnd + 20], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'}),
          }}
        >
          Dropbox asks you to allow the app its own folder: Apps / Health Plan by Dr Brad
        </div>
      </AbsoluteFill>
    </>
  );
};

import React from 'react';
import {AbsoluteFill, interpolate, staticFile, Img} from 'remotion';
import {T, COL_W, SIDEBAR_W, HEADER_H, STAGE_H} from '../theme';
import {Sidebar, Header, Composer} from '../Chrome';
import {UserBubble, ToolRow, StreamText, Card, FileChip, ResultsTable, ResultRow, enter} from '../blocks';
import {useChatScroll} from '../useChatScroll';
import {between, Cursor, SCENE_H} from '../ui';
import {Timing} from '../timing';
import data from '../plan-data.json';

export const SCALE = SCENE_H / STAGE_H;
const STAGE_W = Math.round(1920 / SCALE);
const VIEW_H = STAGE_H - HEADER_H;
const KEEP_H = 520;
const COL_L = SIDEBAR_W + (STAGE_W - SIDEBAR_W - COL_W) / 2;
const TITLE = 'Import my health data';

// Fictional file names and counts; status wording follows the real import_documents
// result states (free / held_equal / held_different, documents[]).
const ROWS: ResultRow[] = [
  {file: 'Labs 2026-06-14.pdf', status: '12 values, 3 new', tone: 'new'},
  {file: 'Lipid panel 2025-11-02.pdf', status: '8 values, already recorded', tone: 'same'},
  {file: 'Renal clinic letter.pdf', status: 'Clinic letter, can be filed', tone: 'filed'},
  {file: 'Labs 2024-02-11.pdf', status: '1 value differs from your record', tone: 'differ'},
];

const ORDER = ['fA', 'uA', 'perm', 'tA', 'aA', 'cA', 'aQ', 'uY', 'tC', 'aS', 'u5', 't5', 'c5'];

const cues = (t: Timing) => {
  const [, , b2, b3, b4, b5] = t.start;
  return {
    fA: b2,
    uA: b2 + 30,
    perm: b2 + 105, // 21.5 s
    allow: b2 + 195, // 24.5 s
    tA: b3,
    aA: b3 + 90,
    cA: b3 + 150,
    aQ: b3 + 330,
    uY: b4,
    tC: b4 + 30,
    aS: b4 + 90,
    u5: b5,
    t5: b5 + 45,
    c5: b5 + 120,
  };
};

/** The permission card, drawn from the live capture (u2a); "Always allow" is the chosen button. */
const PermissionCard: React.FC<{frame: number; at: number; chosen: number; fps: number}> = ({frame, at, chosen, fps}) => {
  const {opacity, s} = enter(frame, at, fps);
  const pressed = interpolate(frame, [chosen, chosen + 6], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
  const btn: React.CSSProperties = {border: `1px solid ${T.line}`, borderRadius: 999, padding: '8px 16px', fontSize: 14, color: T.ink, background: '#fff'};
  return (
    <div
      style={{
        opacity,
        transform: `translateY(${interpolate(s, [0, 1], [10, 0])}px)`,
        margin: '22px 0 0',
        border: `1px solid ${T.line}`,
        borderRadius: 18,
        background: '#fff',
        boxShadow: '0 6px 24px rgba(0,0,0,0.06)',
        fontFamily: T.font,
        overflow: 'hidden',
      }}
    >
      <div style={{padding: '16px 20px 14px'}}>
        <div style={{display: 'flex', alignItems: 'center', gap: 9, color: T.ink2, fontSize: 14, marginBottom: 12}}>
          <Img src={staticFile('app-icon.png')} style={{width: 20, height: 20, borderRadius: 6}} />
          Health by Dr Brad
        </div>
        <div style={{fontSize: 16, fontWeight: 600, color: T.ink, marginBottom: 8}}>Allow ChatGPT to use Health by Dr Brad?</div>
        <div style={{fontSize: 15, lineHeight: '23px', color: T.ink2}}>
          Reads the file you dropped in and saves nothing until you confirm. <span style={{textDecoration: 'underline'}}>See details</span>
        </div>
      </div>
      <div style={{borderTop: `1px solid ${T.line}`, background: '#fafafa', padding: '12px 20px', display: 'flex', alignItems: 'center', gap: 8}}>
        <span
          data-allow
          style={{
            ...btn,
            background: `rgba(13,13,13,${pressed})`,
            color: pressed > 0.5 ? '#fff' : T.ink,
            borderColor: pressed > 0.5 ? T.ink : T.line,
            fontWeight: 500,
          }}
        >
          Always allow
        </span>
        <div style={{flex: 1}} />
        <span style={btn}>Deny</span>
        <span style={{...btn, display: 'flex', alignItems: 'center', gap: 8}}>
          Allow once
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={T.ink} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </span>
      </div>
    </div>
  );
};

/** Beats 2 to 5 in one chat, plus the empty chat the connect beat returns to. */
export const ChatScene: React.FC<{frame: number; from: number; to: number; fps: number; t: Timing}> = ({frame, from, to, fps, t}) => {
  const CUE = cues(t);
  // Always mounted (opacity 0 outside its range) so the layout measurement can run.
  const {contentRef, set, box, scroll} = useChatScroll(ORDER, CUE, frame, VIEW_H, KEEP_H);
  const b2 = data.beat2;

  // cursor target: the "Always allow" button sits bottom-left of the permission card
  const permBox = box?.perm;
  const allowX = COL_L + 20 + 44;
  const allowY = permBox ? HEADER_H + permBox.top + permBox.h - 30 - scroll : 0;

  return (
    <AbsoluteFill style={{background: T.bg, opacity: between(frame, from, to + 10, 10)}}>
      <AbsoluteFill
        style={{
          width: STAGE_W,
          height: STAGE_H,
          transform: `scale(${SCALE})`,
          transformOrigin: 'top left',
          background: T.bg,
        }}
      >
        <Sidebar title={TITLE} />
        <div style={{position: 'absolute', left: SIDEBAR_W, top: HEADER_H, width: STAGE_W - SIDEBAR_W, height: VIEW_H, overflow: 'hidden'}}>
          <div
            ref={contentRef}
            style={{position: 'absolute', left: (STAGE_W - SIDEBAR_W - COL_W) / 2, top: 0, width: COL_W, transform: `translateY(${-scroll}px)`, willChange: 'transform'}}
          >
            {/* beat 2 */}
            <div ref={set('fA')}>
              <FileChip name="health.zip" meta="Zip archive · 2.3 MB" frame={frame} at={CUE.fA} fps={fps} />
            </div>
            <div ref={set('uA')}>
              <UserBubble text="Import this file into my health record." frame={frame} at={CUE.uA} fps={fps} style={{margin: '8px 0 4px'}} />
            </div>
            <div ref={set('perm')}>
              <PermissionCard frame={frame} at={CUE.perm} chosen={CUE.allow} fps={fps} />
            </div>

            {/* beat 3 */}
            <div ref={set('tA')}>
              <ToolRow tool="import_documents" args="file: health.zip" frame={frame} at={CUE.tA} fps={fps} spinFrames={30} />
            </div>
            <div ref={set('aA')}>
              <StreamText frame={frame} at={CUE.aA} text="I read the four files in the zip. Nothing is saved yet." />
            </div>
            <div ref={set('cA')}>
              <ResultsTable rows={ROWS} frame={frame} at={CUE.cA} fps={fps} stagger={45} statusW={300} />
            </div>
            <div ref={set('aQ')}>
              <StreamText
                frame={frame}
                at={CUE.aQ}
                text="Save the 3 new values and file the letter? The value that differs stays as it is unless you say otherwise."
              />
            </div>

            {/* beat 4 */}
            <div ref={set('uY')}>
              <UserBubble text="Yes" frame={frame} at={CUE.uY} fps={fps} />
            </div>
            <div ref={set('tC')}>
              <ToolRow tool="import_documents" args="commit" frame={frame} at={CUE.tC} fps={fps} />
            </div>
            <div ref={set('aS')}>
              <StreamText frame={frame} at={CUE.aS} text="Saved 3 values and filed 1 letter to your health record, in your Dropbox." />
            </div>

            {/* beat 5 */}
            <div ref={set('u5')}>
              <UserBubble text="What does my plan say now?" frame={frame} at={CUE.u5} fps={fps} />
            </div>
            <div ref={set('t5')}>
              <ToolRow tool="get_plan" frame={frame} at={CUE.t5} fps={fps} spinFrames={24} />
            </div>
            <div ref={set('c5')}>
              <Card frame={frame} at={CUE.c5} fps={fps}>
                <div style={{fontSize: 18, fontWeight: 600, color: T.ink, marginBottom: 7}}>{b2.title}</div>
                <div style={{fontSize: 15.5, lineHeight: '24px', color: T.ink}}>{b2.description}</div>
                <div style={{marginTop: 12, fontSize: 13.5, lineHeight: '20px', color: T.ink2}}>
                  {b2.references[0].label} <span style={{color: T.accent}}>{b2.references[0].url.replace('https://', '')}</span>
                </div>
              </Card>
            </div>
            <div style={{height: 190}}>&nbsp;</div>
          </div>
        </div>
        <Header title={TITLE} />
        <Composer width={COL_W} left={COL_L} />
        <Cursor
          frame={frame}
          keys={[
            {at: CUE.perm + 30, x: COL_L + 560, y: 560},
            {at: CUE.allow - 4, x: allowX, y: allowY},
          ]}
          clicks={[CUE.allow]}
          show={[CUE.perm + 24, CUE.allow + 18]}
        />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

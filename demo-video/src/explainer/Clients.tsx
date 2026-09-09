import React from 'react';
import {AbsoluteFill, interpolate} from 'remotion';
import {T} from '../theme';
import {between} from '../ui';

const C = {ground: '#f5f8f7', ink: '#172422', muted: '#5b6b68', line: '#dde4e2', accent: '#00a38b', term: '#12211f'};
const URL = 'https://mcp.drstanfield.com/mcp';
const PANEL_W = 540;
const PANEL_H = 380;
const PANEL_T = 320;
const GAP = 60;
const PANEL_L = (1920 - 3 * PANEL_W - 2 * GAP) / 2;
const EACH = 70; // frames a panel holds the focus (about 2.3 s)

/** Characters revealed over `len` frames from `at`, with a block caret while typing. */
const Typed: React.FC<{text: string; frame: number; at: number; len?: number; style?: React.CSSProperties}> = ({
  text,
  frame,
  at,
  len = 40,
  style,
}) => {
  const n = Math.round(interpolate(frame, [at, at + len], [0, text.length], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'}));
  const typing = frame >= at && frame < at + len + 6;
  return (
    <span style={style}>
      {text.slice(0, n)}
      {typing ? <span style={{opacity: Math.floor((frame - at) / 8) % 2 ? 0.2 : 1}}>▌</span> : null}
    </span>
  );
};

const Panel: React.FC<{label: string; active: number; children: React.ReactNode; index: number}> = ({
  label,
  active,
  children,
  index,
}) => (
  <div
    style={{
      position: 'absolute',
      left: PANEL_L + index * (PANEL_W + GAP),
      top: PANEL_T,
      width: PANEL_W,
      opacity: interpolate(active, [0, 1], [0.42, 1]),
      transform: `scale(${interpolate(active, [0, 1], [0.94, 1])})`,
      transformOrigin: 'center top',
    }}
  >
    <div style={{fontSize: 26, fontWeight: 700, color: C.ink, marginBottom: 16, letterSpacing: -0.3}}>{label}</div>
    <div
      style={{
        height: PANEL_H,
        borderRadius: 16,
        overflow: 'hidden',
        border: `1px solid ${C.line}`,
        background: '#fff',
        boxShadow: `0 12px 40px rgba(23,36,34,${0.05 + 0.09 * active})`,
      }}
    >
      {children}
    </div>
  </div>
);

const Bar: React.FC<{title: string; dark?: boolean}> = ({title, dark}) => (
  <div
    style={{
      height: 46,
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '0 16px',
      background: dark ? '#0c1917' : '#f3f5f4',
      borderBottom: `1px solid ${dark ? '#1d322e' : C.line}`,
      color: dark ? '#8ba39d' : C.muted,
      fontSize: 15,
    }}
  >
    {['#fe5f57', '#febc2e', '#28c840'].map((c) => (
      <span key={c} style={{width: 11, height: 11, borderRadius: 99, background: c}} />
    ))}
    <span style={{margin: '0 auto', paddingRight: 33}}>{title}</span>
  </div>
);

const Field: React.FC<{label: string; children: React.ReactNode; focus?: boolean}> = ({label, children, focus}) => (
  <div style={{marginTop: 20}}>
    <div style={{fontSize: 14, fontWeight: 600, color: C.muted, marginBottom: 8}}>{label}</div>
    <div
      style={{
        border: `1px solid ${focus ? C.accent : C.line}`,
        boxShadow: focus ? `0 0 0 3px rgba(0,163,139,0.14)` : 'none',
        borderRadius: 10,
        padding: '11px 14px',
        fontSize: 15,
        color: C.ink,
        background: '#fff',
        minHeight: 22,
        wordBreak: 'break-all',
      }}
    >
      {children}
    </div>
  </div>
);

const Term: React.FC<{children: React.ReactNode}> = ({children}) => (
  <div style={{background: C.term, height: '100%', padding: '20px 20px', fontFamily: T.mono, fontSize: 16, lineHeight: '26px', color: '#dbe7e3', boxSizing: 'border-box'}}>
    {children}
  </div>
);

const Line: React.FC<{children: React.ReactNode; muted?: boolean}> = ({children, muted}) => (
  <div style={{whiteSpace: 'pre-wrap', overflowWrap: 'break-word', color: muted ? '#7f9992' : '#dbe7e3', marginBottom: 10}}>{children}</div>
);

const Prompt = () => <span style={{color: '#4fd1b0'}}>$ </span>;

/**
 * Beat 1, first half: the three ways to add the connector, about 2.3 s each, then
 * the panels collapse into the consent screen that follows.
 */
export const Clients: React.FC<{frame: number; from: number; to: number}> = ({frame, from, to}) => {
  if (frame < from - 1 || frame > to + 12) return null;
  const f = frame - from;
  const at = (i: number) => i * EACH;
  const active = (i: number) =>
    interpolate(f, [at(i) - 10, at(i) + 8, at(i) + EACH + 6, at(i) + EACH + 22], [0, 1, 1, 0.42], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    });
  const collapse = interpolate(frame, [to - 12, to + 8], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
  return (
    <AbsoluteFill style={{background: C.ground, fontFamily: T.font, opacity: between(frame, from, to + 10, 10)}}>
      <div style={{position: 'absolute', inset: 0, transform: `scale(${1 - 0.1 * collapse})`, transformOrigin: '960px 500px'}}>
        <div style={{position: 'absolute', left: 0, right: 0, top: 150, textAlign: 'center', fontSize: 46, fontWeight: 700, color: C.ink, letterSpacing: -0.6}}>
          One connector. Three ways to add it.
        </div>

        <Panel index={0} label="Claude" active={active(0)}>
          <Bar title="Settings · Connectors" />
          <div style={{padding: '22px 24px'}}>
            <div style={{fontSize: 19, fontWeight: 700, color: C.ink}}>Add custom connector</div>
            <Field label="Name">Health by Dr Brad</Field>
            <Field label="Remote MCP server URL" focus>
              <Typed text={URL} frame={f} at={at(0) + 14} len={34} style={{fontFamily: T.mono, fontSize: 14.5}} />
            </Field>
            <div
              style={{
                marginTop: 24,
                display: 'inline-block',
                background: C.accent,
                color: '#fff',
                borderRadius: 10,
                padding: '11px 26px',
                fontSize: 16,
                fontWeight: 600,
              }}
            >
              Add
            </div>
          </div>
        </Panel>

        <Panel index={1} label="Claude Code" active={active(1)}>
          <Bar title="Terminal" dark />
          <Term>
            <Line>
              <Prompt />
              <Typed text="claude mcp add --transport http health https://mcp.drstanfield.com/mcp" frame={f} at={at(1) + 8} len={38} />
            </Line>
            <Line muted>{f > at(1) + 50 ? 'Added HTTP MCP server health' : ''}</Line>
          </Term>
        </Panel>

        <Panel index={2} label="Codex" active={active(2)}>
          <Bar title="Terminal" dark />
          <Term>
            <Line>
              <Prompt />
              <Typed text="codex mcp add health --url https://mcp.drstanfield.com/mcp" frame={f} at={at(2) + 6} len={26} />
            </Line>
            <Line muted>{f > at(2) + 34 ? 'Added server health' : ''}</Line>
            {f > at(2) + 38 ? (
              <>
                <Line>
                  <Prompt />
                  <Typed text="codex mcp login health" frame={f} at={at(2) + 40} len={12} />
                </Line>
                <Line muted>{f > at(2) + 56 ? 'Signed in. health is ready.' : ''}</Line>
              </>
            ) : null}
          </Term>
        </Panel>
      </div>
    </AbsoluteFill>
  );
};

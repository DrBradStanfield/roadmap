import React from 'react';
import {AbsoluteFill} from 'remotion';
import {T, COL_W, SIDEBAR_W, HEADER_H, STAGE_H} from '../theme';
import {Sidebar, Header, Composer} from '../Chrome';
import {UserBubble, StreamText} from '../blocks';
import {between, fadeIn, SCENE_H} from '../ui';
import {RepoCard} from './Repo';
import {BrowserFrame, ResultsMatrix} from './Website';

/**
 * Placeholder. The audited wording drops in here, and nowhere else, before the
 * final render: what the assistant actually says after reading the code.
 */
export const VERIFY_REPLY = 'Reading the code now… [reply verified before final render]';

const PROMPT =
  "I'm deeply skeptical about Dr Brad's project. I'm sure it must be stealing or saving my health data. " +
  "Here's the code: https://github.com/DrBradStanfield/roadmap. Check it thoroughly to make sure it's not taking my health data.";

const SCALE = SCENE_H / STAGE_H;
const STAGE_W = Math.round(1920 / SCALE);
const COL_L = SIDEBAR_W + (STAGE_W - SIDEBAR_W - COL_W) / 2;
const TITLE = 'Is this thing safe?';

/** Beat 6: hand the skeptic's prompt to the assistant, then the repository, then the app on GitHub Pages. */
export const Verify: React.FC<{frame: number; from: number; to: number; fps: number}> = ({frame, from, to, fps}) => {
  if (frame < from - 1 || frame > to + 12) return null;
  const f = frame - from;
  const chatEnd = from + 150; // 5 s in the chat
  const repoEnd = from + 225; // 2.5 s on the repository
  return (
    <>
      <AbsoluteFill style={{background: T.bg, opacity: between(frame, from, chatEnd, 10)}}>
        <AbsoluteFill style={{width: STAGE_W, height: STAGE_H, transform: `scale(${SCALE})`, transformOrigin: 'top left', background: T.bg}}>
          <Sidebar title={TITLE} />
          <div style={{position: 'absolute', left: COL_L, top: HEADER_H + 120, width: COL_W}}>
            <UserBubble text={PROMPT} frame={frame} at={from + 8} fps={fps} />
            <StreamText frame={frame} at={from + 78} text={VERIFY_REPLY} />
          </div>
          <Header title={TITLE} />
          <Composer width={COL_W} left={COL_L} />
        </AbsoluteFill>
      </AbsoluteFill>

      <AbsoluteFill style={{background: '#f5f8f7', fontFamily: T.font, opacity: between(frame, chatEnd, repoEnd, 10)}}>
        <div style={{position: 'absolute', left: 300, right: 300, top: 210}}>
          <div style={{fontSize: 44, lineHeight: 1.25, fontWeight: 700, color: '#172422', letterSpacing: -0.5, textAlign: 'center', marginBottom: 34}}>
            Every line of it, in the open.
          </div>
          <RepoCard scale={1.9} />
        </div>
      </AbsoluteFill>

      <AbsoluteFill style={{background: '#e9edec', fontFamily: T.font, opacity: between(frame, repoEnd, to + 10, 10)}}>
        <BrowserFrame url="drbradstanfield.github.io/roadmap">
          <ResultsMatrix f={f - 225} colW={150} />
        </BrowserFrame>
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: 810,
            textAlign: 'center',
            opacity: fadeIn(f, 255, 12),
          }}
        >
          <span
            style={{
              display: 'inline-block',
              background: 'rgba(23,36,34,0.92)',
              color: '#fff',
              fontSize: 30,
              fontWeight: 600,
              borderRadius: 999,
              padding: '14px 34px',
            }}
          >
            The same app, served from the repository. No server of mine at all.
          </span>
        </div>
      </AbsoluteFill>
    </>
  );
};

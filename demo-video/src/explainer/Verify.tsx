import React from 'react';
import {AbsoluteFill} from 'remotion';
import {T, COL_W, SIDEBAR_W, HEADER_H, STAGE_H} from '../theme';
import {Sidebar, Header, Composer} from '../Chrome';
import {UserBubble, StreamText} from '../blocks';
import {between, fadeIn, SCENE_H} from '../ui';
import {RepoCard} from './Repo';
import {BrowserFrame, ResultsMatrix} from './Website';

export const VERIFY_REPLY =
  "I looked at the repo and the page you linked. I didn't find a path that ships your health record to " +
  "Dr Brad's server. Your record is one JSON file written by the adapters in widget-src/src/storage/, to " +
  "Dropbox, Drive, GitHub, WebDAV, or localStorage; there is no endpoint on his server that accepts it.";

const PROMPT =
  "I'm deeply skeptical of dr brad's health tool. I'm sure it must be stealing my health data somehow. " +
  "here's the project and MCP: https://github.com/DrBradStanfield/roadmap and here's the github pages page: " +
  "https://drbradstanfield.github.io/roadmap/ thoroughly check to see how this is stealing my health data";

const SCALE = SCENE_H / STAGE_H;
const STAGE_W = Math.round(1920 / SCALE);
const COL_L = SIDEBAR_W + (STAGE_W - SIDEBAR_W - COL_W) / 2;
const TITLE = 'Is this thing safe?';

/** Beat 6: hand the skeptic's prompt to the assistant, then the repository, then the app on GitHub Pages. */
export const Verify: React.FC<{frame: number; from: number; to: number; fps: number}> = ({frame, from, to, fps}) => {
  if (frame < from - 1 || frame > to + 12) return null;
  const f = frame - from;
  const chatEnd = from + 180; // 6 s in the chat: long prompt, then the whole reply
  const repoEnd = from + 250; // 2.3 s on the repository
  return (
    <>
      <AbsoluteFill style={{background: T.bg, opacity: between(frame, from, chatEnd, 10)}}>
        <AbsoluteFill style={{width: STAGE_W, height: STAGE_H, transform: `scale(${SCALE})`, transformOrigin: 'top left', background: T.bg}}>
          <Sidebar title={TITLE} />
          <div style={{position: 'absolute', left: COL_L, top: HEADER_H + 120, width: COL_W}}>
            <UserBubble text={PROMPT} frame={frame} at={from + 8} fps={fps} />
            <StreamText frame={frame} at={from + 55} perWord={1.4} text={VERIFY_REPLY} />
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
          <ResultsMatrix f={f - 250} colW={150} />
        </BrowserFrame>
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: 810,
            textAlign: 'center',
            opacity: fadeIn(f, 280, 12),
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

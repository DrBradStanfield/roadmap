import React from 'react';
import {AbsoluteFill, Audio, staticFile, useCurrentFrame, useVideoConfig} from 'remotion';
import {connectTiming, hasVo, CONNECT_CAPTIONS, CONNECT_WEBSITE_BEAT} from './timing';
import {Captions} from './ui';
import {Why} from './explainer/Why';
import {Clients} from './explainer/Clients';
import {Connect} from './explainer/Connect';
import {Folder} from './explainer/Folder';
import {ChatScene} from './explainer/ChatScene';
import {Verify} from './explainer/Verify';
import {WebsiteSync} from './explainer/Website';
import {Close} from './explainer/Close';

const CLIENT = 'your assistant';

/**
 * Video A, "Connect your assistant" (STORYBOARDS.md, approved 2026-09-10): ten beats,
 * timed from vo-connect.json. `website` drops beat 7 for the short cut. No vendor is
 * named on screen; the narration names Claude, Claude Code and Codex only.
 */
export const ConnectExplainer: React.FC<{website: boolean}> = ({website}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const t = connectTiming(website);
  const b = t.start;
  const consentFrom = b[1] + 210; // the three client panels hold the first 7 s of beat 1
  const chatFrom = b[2] + 60; // the folder holds the first 2 s of beat 2
  return (
    <AbsoluteFill style={{background: '#141a19'}}>
      <Why frame={frame} from={b[0]} to={b[1]} fps={fps} repo />
      <Clients frame={frame} from={b[1]} to={consentFrom} />
      <Connect frame={frame} from={consentFrom} to={b[2]} client={CLIENT} />
      <Folder frame={frame} from={b[2]} to={chatFrom} />
      <ChatScene frame={frame} from={chatFrom} to={b[6]} fps={fps} t={t} variant="folder" client={CLIENT} />
      <Verify frame={frame} from={b[6]} to={b[7]} fps={fps} />
      {website ? <WebsiteSync frame={frame} from={b[7]} to={b[8]} fps={fps} /> : null}
      <Close frame={frame} from={b[8]} to={b[9]} />
      <Captions frame={frame} t={t} captions={CONNECT_CAPTIONS} websiteBeat={CONNECT_WEBSITE_BEAT} />
      {hasVo ? <Audio src={staticFile('vo-connect.mp3')} /> : null}
    </AbsoluteFill>
  );
};

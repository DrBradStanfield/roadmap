import React from 'react';
import {AbsoluteFill, Audio, staticFile, useCurrentFrame, useVideoConfig} from 'remotion';
import {timing, hasVo} from './timing';
import {Captions} from './ui';
import {Why} from './explainer/Why';
import {Connect} from './explainer/Connect';
import {ChatScene} from './explainer/ChatScene';
import {Website} from './explainer/Website';
import {Close} from './explainer/Close';

/**
 * Storyboard revision 3: beats 0 to 7. Beat starts come from vo.json; `website`
 * drops beat 6 for the 64 s cut. Captions are burned into the bottom band.
 */
export const ImportExplainer: React.FC<{website: boolean}> = ({website}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const t = timing(website);
  const b = t.start;
  const chatFrom = b[1] + 180; // back to the chat 6 s into the connect beat
  return (
    <AbsoluteFill style={{background: '#141a19'}}>
      <Why frame={frame} from={b[0]} to={b[1]} fps={fps} />
      <Connect frame={frame} from={b[1]} to={chatFrom} />
      <ChatScene frame={frame} from={chatFrom} to={b[6]} fps={fps} t={t} />
      {website ? <Website frame={frame} from={b[6]} to={b[7]} fps={fps} /> : null}
      <Close frame={frame} from={b[7]} to={b[8]} />
      <Captions frame={frame} t={t} />
      {hasVo ? <Audio src={staticFile('vo.mp3')} /> : null}
    </AbsoluteFill>
  );
};

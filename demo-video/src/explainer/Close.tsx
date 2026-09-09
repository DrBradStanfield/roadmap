import React from 'react';
import {AbsoluteFill, staticFile, Img} from 'remotion';
import {T} from '../theme';
import {fadeIn, SCENE_H} from '../ui';

/** Beat 7: the consent page's last line, then the promise. */
export const Close: React.FC<{frame: number; from: number; to: number}> = ({frame, from, to}) => {
  if (frame < from - 1 || frame > to) return null;
  const f = frame - from;
  return (
    <AbsoluteFill style={{background: '#f5f8f7', fontFamily: T.font, opacity: fadeIn(f, 0, 10)}}>
      <div style={{position: 'absolute', left: 0, right: 0, top: SCENE_H / 2 - 190, textAlign: 'center', padding: '0 260px'}}>
        <div style={{display: 'inline-flex', alignItems: 'center', gap: 16, fontSize: 30, fontWeight: 600, color: '#0b6f61', opacity: fadeIn(f, 6, 12)}}>
          <Img src={staticFile('app-icon.png')} style={{width: 56, height: 56, borderRadius: 14}} />
          Health by Dr Brad
        </div>
        <div style={{fontSize: 46, lineHeight: 1.3, fontWeight: 700, color: '#172422', marginTop: 46, opacity: fadeIn(f, 20, 14)}}>
          Educational, not medical advice.
          <br />
          Take it to your doctor.
        </div>
        <div style={{fontSize: 40, color: '#5b6b68', marginTop: 40, opacity: fadeIn(f, 60, 14)}}>Your data stays yours.</div>
      </div>
    </AbsoluteFill>
  );
};

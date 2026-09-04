import React from 'react';
import {Composition} from 'remotion';
import {ApobDemo} from './ApobDemo';

export const RemotionRoot: React.FC = () => (
  <Composition
    id="ApobDemo"
    component={ApobDemo}
    durationInFrames={690}
    fps={30}
    width={1920}
    height={1080}
  />
);

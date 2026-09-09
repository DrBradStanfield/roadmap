import React from 'react';
import {Composition} from 'remotion';
import {ApobDemo} from './ApobDemo';
import {ImportExplainer} from './ImportExplainer';
import {timing, FPS} from './timing';

const base = {fps: FPS, width: 1920, height: 1080};

export const RemotionRoot: React.FC = () => (
  <>
    <Composition id="ApobDemo" component={ApobDemo} durationInFrames={1200} {...base} />
    <Composition
      id="ImportExplainer"
      component={ImportExplainer}
      durationInFrames={timing(true).end}
      defaultProps={{website: true}}
      {...base}
    />
    <Composition
      id="ImportExplainer60"
      component={ImportExplainer}
      durationInFrames={timing(false).end}
      defaultProps={{website: false}}
      {...base}
    />
  </>
);

import React from 'react';
import {Composition} from 'remotion';
import {ApobDemo} from './ApobDemo';
import {ImportExplainer} from './ImportExplainer';
import {ConnectExplainer} from './ConnectExplainer';
import {timing, connectTiming, FPS} from './timing';

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
    <Composition
      id="ConnectExplainer"
      component={ConnectExplainer}
      durationInFrames={connectTiming(true).end}
      defaultProps={{website: true}}
      {...base}
    />
    <Composition
      id="ConnectExplainerShort"
      component={ConnectExplainer}
      durationInFrames={connectTiming(false).end}
      defaultProps={{website: false}}
      {...base}
    />
  </>
);

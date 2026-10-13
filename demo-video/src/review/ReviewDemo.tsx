import React from 'react';
import {AbsoluteFill, Audio, Img, OffthreadVideo, Sequence, interpolate, staticFile, useCurrentFrame} from 'remotion';
import timeline from './timeline.json';

// The OpenAI review demo (docs/chatgpt-review/demo-script.md): frames captured from a live
// ChatGPT session on the review account, laid against Brad's voice-over, one segment per step.
// Nothing here is drawn to look like ChatGPT: every screen is a capture.

const BAND = 150;
const BG = '#0d0f0f';
const INK = '#f2f4f3';
const DIM = '#9aa3a1';
const ACCENT = '#2fb38f';
const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Helvetica, Arial, sans-serif';

type Segment = (typeof timeline.segments)[number];

const fade = (frame: number, dur: number, len = 8) =>
  Math.min(
    interpolate(frame, [0, len], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'}),
    interpolate(frame, [dur - len, dur], [1, 0], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'}),
  );

/** The segment's captured frames, spread evenly across it, each crossfading into the next. */
const Frames: React.FC<{seg: Segment}> = ({seg}) => {
  const frame = useCurrentFrame();
  const n = seg.frames.length;
  const each = seg.dur / n;
  return (
    <AbsoluteFill style={{bottom: BAND, height: 1080 - BAND}}>
      {seg.frames.map((src, i) => {
        const from = i * each;
        const opacity = interpolate(frame, [from - 6, from + 6, from + each - 6, from + each + 6], [0, 1, 1, i === n - 1 ? 1 : 0], {
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
        });
        return (
          <AbsoluteFill key={src} style={{opacity, display: 'flex', alignItems: 'center', justifyContent: 'center'}}>
            <Img src={staticFile(src)} style={{height: 1080 - BAND - 40, width: 'auto', maxWidth: 1880, borderRadius: 10, boxShadow: '0 8px 40px rgba(0,0,0,.6)'}} />
          </AbsoluteFill>
        );
      })}
    </AbsoluteFill>
  );
};

const Card: React.FC<{title: string; lines: string[]; small?: string}> = ({title, lines, small}) => (
  <AbsoluteFill style={{bottom: BAND, height: 1080 - BAND, alignItems: 'center', justifyContent: 'center', gap: 28, fontFamily: FONT}}>
    <Img src={staticFile('app-icon.png')} style={{width: 150, height: 150, borderRadius: 34}} />
    <div style={{color: INK, fontSize: 72, fontWeight: 650, letterSpacing: -1}}>{title}</div>
    {lines.map((l) => (
      <div key={l} style={{color: DIM, fontSize: 34, maxWidth: 1300, textAlign: 'center', lineHeight: 1.35}}>{l}</div>
    ))}
    {small ? <div style={{color: DIM, fontSize: 24, marginTop: 20}}>{small}</div> : null}
  </AbsoluteFill>
);

const CaptionBand: React.FC<{seg: Segment}> = ({seg}) => {
  const frame = useCurrentFrame();
  const current = [...seg.captions].reverse().find((c) => frame >= c.at) ?? seg.captions[0];
  return (
    <div style={{position: 'absolute', left: 0, right: 0, bottom: 0, height: BAND, background: '#141a19', borderTop: `2px solid ${ACCENT}`, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 120px'}}>
      <div style={{color: INK, fontFamily: FONT, fontSize: 36, lineHeight: 1.3, textAlign: 'center'}}>{current?.text}</div>
    </div>
  );
};

const Body: React.FC<{seg: Segment}> = ({seg}) => {
  const frame = useCurrentFrame();
  const opacity = fade(frame, seg.dur);
  if (seg.id === 's0') {
    return (
      <div style={{opacity}}>
        <Card
          title="Health by Dr Brad"
          lines={['A live ChatGPT session on the account made for your review, holding invented data.', 'Developer connection to the same server the plugin uses. Long waits are cut.']}
          small="Recorded 12 October 2026"
        />
      </div>
    );
  }
  if (seg.id === 's1') {
    return (
      <AbsoluteFill style={{opacity, bottom: BAND, height: 1080 - BAND, display: 'flex', alignItems: 'center', justifyContent: 'center'}}>
        <OffthreadVideo src={staticFile('review/s1.mp4')} playbackRate={2} muted style={{maxWidth: 1880, maxHeight: 1080 - BAND - 30, borderRadius: 10}} />
      </AbsoluteFill>
    );
  }
  if (seg.id === 's9') {
    return (
      <div style={{opacity}}>
        <Card title="Thank you" lines={['Health by Dr Brad · drstanfield.com']} small="Voice-over generated from Brad Stanfield's own voice." />
      </div>
    );
  }
  return (
    <div style={{opacity}}>
      <Frames seg={seg} />
    </div>
  );
};

export const ReviewDemo: React.FC = () => (
  <AbsoluteFill style={{background: BG}}>
    {timeline.segments.map((seg) => (
      <Sequence key={seg.id} from={seg.start} durationInFrames={seg.dur}>
        <Body seg={seg} />
        <CaptionBand seg={seg} />
        <Audio src={staticFile(seg.audio)} />
      </Sequence>
    ))}
  </AbsoluteFill>
);

export const REVIEW_DEMO_FRAMES = timeline.total;

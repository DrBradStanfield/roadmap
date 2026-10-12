// The review demo's timeline (docs/chatgpt-review/demo-script.md): one entry per narration
// segment, timed by its voice-over clip, showing the captured frames of that step of the live
// ChatGPT session. Copies the clips, frames and the scene-1 recording into demo-video/public/review/
// and writes demo-video/src/review/timeline.json for the ReviewDemo composition.
// Usage: node docs/chatgpt-review/demo/build-timeline.mjs
import fs from 'node:fs';
import path from 'node:path';

const HERE = import.meta.dirname;
const ROOT = path.resolve(HERE, '../../..');
const PUBLIC = path.join(ROOT, 'demo-video/public/review');
const FPS = 30;
const PAD_SECONDS = 0.8;

const narration = JSON.parse(fs.readFileSync(path.join(HERE, 'narration.json'), 'utf8'));
/** Scenes drawn from captured frames; s0 and s9 are cards and s1 is the screen recording. */
const FRAME_SCENES = ['s2', 's3', 's4', 's5', 's6', 's7', 's8'];

// Every input is checked before anything is replaced: a scene with no frames would render blank
// while its narration plays.
for (const id of FRAME_SCENES) {
  const dir = path.join(HERE, 'out/frames', id);
  if (!fs.existsSync(dir) || !fs.readdirSync(dir).some((f) => f.endsWith('.jpg'))) throw new Error(`no frames for ${id} in ${dir}`);
}
if (!fs.existsSync(path.join(HERE, 'out/seg1.mp4'))) throw new Error('out/seg1.mp4 (scene 1) is missing');
for (const { id } of narration) {
  if (!fs.existsSync(path.join(HERE, 'audio', `${id}.mp3`))) throw new Error(`no voice-over clip for ${id}: run tts.mjs`);
}

/** Captions: the segment's sentences, each starting when its first character is spoken. */
function captions(text, alignment) {
  const chars = alignment.characters.join('');
  const starts = alignment.character_start_times_seconds;
  const out = [];
  let from = 0;
  for (const sentence of text.match(/[^.!?]+[.!?]+/g) ?? [text]) {
    const at = chars.indexOf(sentence.trim()[0], from);
    out.push({ text: sentence.trim(), at: Math.round((starts[Math.max(at, 0)] ?? 0) * FPS) });
    from = at + sentence.trim().length;
  }
  return out;
}

fs.rmSync(PUBLIC, { recursive: true, force: true });
fs.mkdirSync(PUBLIC, { recursive: true });
let start = 0;
const segments = narration.map(({ id, text }) => {
  const alignment = JSON.parse(fs.readFileSync(path.join(HERE, 'audio', `${id}.alignment.json`), 'utf8'));
  const ends = alignment.character_end_times_seconds;
  const dur = Math.round((ends[ends.length - 1] + PAD_SECONDS) * FPS);
  fs.copyFileSync(path.join(HERE, 'audio', `${id}.mp3`), path.join(PUBLIC, `${id}.mp3`));
  const dir = path.join(HERE, 'out/frames', id);
  const frames = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => f.endsWith('.jpg')).sort().map((f) => {
        fs.mkdirSync(path.join(PUBLIC, id), { recursive: true });
        fs.copyFileSync(path.join(dir, f), path.join(PUBLIC, id, f));
        return `review/${id}/${f}`;
      })
    : [];
  const entry = { id, start, dur, audio: `review/${id}.mp3`, frames, captions: captions(text, alignment) };
  start += dur;
  return entry;
});
fs.copyFileSync(path.join(HERE, 'out/seg1.mp4'), path.join(PUBLIC, 's1.mp4'));
const out = path.join(ROOT, 'demo-video/src/review/timeline.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ fps: FPS, total: start, segments }, null, 1) + '\n');
console.log(`timeline: ${segments.length} segments, ${(start / FPS).toFixed(1)} s`);
for (const s of segments) console.log(`  ${s.id} ${(s.dur / FPS).toFixed(1)} s, ${s.frames.length} frames`);

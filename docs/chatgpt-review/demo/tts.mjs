// The review demo's voice-over (docs/chatgpt-review/demo-script.md): one ElevenLabs
// clip per narration segment, in Brad's own cloned voice, with character timings.
// Usage: node docs/chatgpt-review/demo/tts.mjs [segment id ...]   (no ids = all)
// The key comes from claude_business/claude-integration/.env (ELEVENLABS_API) and is
// never printed. A failed segment exits nonzero and leaves no clip behind, so a stale
// clip is never mistaken for the current narration.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const HERE = import.meta.dirname;
const ENV = `${process.env.HOME}/Library/CloudStorage/Dropbox/YouTube/multivitamin & others/claude_business/claude-integration/.env`;
const VOICE = '7ldoJp0BPWRFSdfpq0CF';
const URL = `https://api.elevenlabs.io/v1/text-to-speech/${VOICE}/with-timestamps?output_format=mp3_44100_128`;

/** Renders each requested segment into `dir`; returns the ids that failed. */
export async function synthesize(segments, only, { key, dir, fetchFn = fetch, log = console.log }) {
  const unknown = only.filter((id) => !segments.some((s) => s.id === id));
  if (unknown.length) throw new Error(`unknown segment id: ${unknown.join(', ')}`);
  fs.mkdirSync(dir, { recursive: true });
  const failed = [];
  for (const { id, text } of segments) {
    if (only.length && !only.includes(id)) continue;
    const mp3 = path.join(dir, `${id}.mp3`);
    const alignment = path.join(dir, `${id}.alignment.json`);
    const drop = () => { for (const f of [mp3, alignment]) try { fs.rmSync(f, { force: true }); } catch {} };
    drop();
    try {
      const res = await fetchFn(URL, {
        method: 'POST',
        headers: { 'xi-api-key': key, 'content-type': 'application/json' },
        body: JSON.stringify({ text, model_id: 'eleven_v4', seed: 20261004,
          voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0, use_speaker_boost: true, speed: 1.0 } }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      const ends = j?.alignment?.character_end_times_seconds;
      if (!j?.audio_base64 || !Array.isArray(ends) || !ends.length) throw new Error('no audio or no alignment');
      fs.writeFileSync(mp3, Buffer.from(j.audio_base64, 'base64'));
      fs.writeFileSync(alignment, JSON.stringify(j.alignment));
      log(`${id} ok ${ends[ends.length - 1].toFixed(2)} s`);
    } catch (err) {
      drop();
      log(`${id} FAILED ${err.message}`);
      failed.push(id);
    }
  }
  return failed;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const key = fs.readFileSync(ENV, 'utf8').split('\n').find((l) => l.startsWith('ELEVENLABS_API='))
    ?.split('=')[1].trim().replace(/^["']|["']$/g, '');
  if (!key) throw new Error('ELEVENLABS_API missing');
  const segments = JSON.parse(fs.readFileSync(path.join(HERE, 'narration.json'), 'utf8'));
  const failed = await synthesize(segments, process.argv.slice(2), { key, dir: path.join(HERE, 'audio') });
  if (failed.length) {
    console.error(`Failed: ${failed.join(', ')}`);
    process.exit(1);
  }
}

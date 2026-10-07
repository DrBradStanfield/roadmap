/**
 * US-32 AC44 — the review demo's voice-over never passes off a stale clip as
 * current: a failed segment is reported, leaves no clip, and only the segments
 * asked for are rendered. No paid API call: fetch is mocked.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { synthesize } from './tts.mjs';

const SEGMENTS = [{ id: 's0', text: 'One.' }, { id: 's1', text: 'Two.' }];
const ok = () => new Response(JSON.stringify({
  audio_base64: Buffer.from('mp3').toString('base64'),
  alignment: { characters: ['O'], character_start_times_seconds: [0], character_end_times_seconds: [1.5] },
}));
let dir: string;
const quiet = () => {};

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-')); });

describe('tts.mjs synthesize', () => {
  it('renders only the requested segments', async () => {
    const calls: string[] = [];
    const failed = await synthesize(SEGMENTS, ['s1'], {
      key: 'k', dir, log: quiet,
      fetchFn: async (_url: string, init: RequestInit) => { calls.push(JSON.parse(String(init.body)).text); return ok(); },
    });
    expect(failed).toEqual([]);
    expect(calls).toEqual(['Two.']);
    expect(fs.readdirSync(dir).sort()).toEqual(['s1.alignment.json', 's1.mp3']);
  });

  it('reports a failed segment and removes its old clip', async () => {
    fs.writeFileSync(path.join(dir, 's0.mp3'), 'stale');
    fs.writeFileSync(path.join(dir, 's0.alignment.json'), '{}');
    const failed = await synthesize(SEGMENTS, [], {
      key: 'k', dir, log: quiet,
      fetchFn: async (_url: string, init: RequestInit) =>
        JSON.parse(String(init.body)).text === 'One.' ? new Response('quota', { status: 429 }) : ok(),
    });
    expect(failed).toEqual(['s0']);
    expect(fs.existsSync(path.join(dir, 's0.mp3'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 's0.alignment.json'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 's1.mp3'))).toBe(true);
  });

  it('fails a segment whose answer has no alignment, leaving no clip', async () => {
    const failed = await synthesize(SEGMENTS, ['s0'], {
      key: 'k', dir, log: quiet,
      fetchFn: async () => new Response(JSON.stringify({ audio_base64: Buffer.from('mp3').toString('base64'), alignment: null })),
    });
    expect(failed).toEqual(['s0']);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('removes both files when a failure comes after they were written', async () => {
    const failed = await synthesize(SEGMENTS, ['s0'], {
      key: 'k', dir, fetchFn: async () => ok(),
      log: (line: string) => { if (line.includes(' ok ')) throw new Error('late failure'); },
    });
    expect(failed).toEqual(['s0']);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('refuses an unknown segment id before any call', async () => {
    let called = false;
    await expect(synthesize(SEGMENTS, ['s9'], {
      key: 'k', dir, log: quiet, fetchFn: async () => { called = true; return ok(); },
    })).rejects.toThrow('unknown segment id: s9');
    expect(called).toBe(false);
  });
});

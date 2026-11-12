import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Story: US-50 (YouTube bot), US-15 AC48 (skips). Golden pins for the file-size split of
// youtube-comment-dryrun.ts (US-64 AC23). The tool exports nothing and runs on import, so these
// pins import it as the CLI runs: argv set, fetch stubbed, the YouTube shell-out mocked, writes caught.
// Synthetic text only: an invented "zeta" post and invented comments. No network, no real key ('stub').
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VIDEO_ID = 'zzSynthVid1';
const SYNTH_BODY = 'Synthetic body: zeta is an invented supplement for this pin.';
const SYNTH_INDEX = [
  { handle: 'synthetic-zeta-video', title: 'Synthetic zeta video', url: 'https://example.org/v', tags: [], publishedAt: '2026-01-02T00:00:00Z', youtube: `https://youtu.be/${VIDEO_ID}`, summary: 'Invented.', type: 'article' },
  { handle: 'synthetic-zeta-guide', title: 'Synthetic zeta guide', url: 'https://example.org/g', tags: [], publishedAt: '2026-01-03T00:00:00Z', summary: 'Invented guide.', type: 'article' },
];

vi.mock('../app/lib/blog-index.server', async (orig) => ({
  ...(await orig<typeof import('../app/lib/blog-index.server')>()),
  loadBlogIndex: () => SYNTH_INDEX,
  findBlogByVideoId: (id: string) => SYNTH_INDEX.find(e => e.youtube?.includes(id)) ?? null,
}));
vi.mock('../app/lib/matched-content', async (orig) => ({
  ...(await orig<typeof import('../app/lib/matched-content')>()),
  loadMatchedContent: (handles: string[]) => ({ content: handles.length ? `Synthetic matched text: ${handles.join(', ')}` : null, titles: [], skipped: [], reduced: [] }),
}));
const spawnCalls: unknown[][] = [];
const COMMENTS = [
  { author: 'Zed Viewer', text: 'Too short here', likes: 9, replyCount: 0, publishedAt: '2026-01-05' },
  { author: 'Dr Brad Stanfield', text: 'Thanks everyone for watching this zeta video', likes: 8, replyCount: 1, publishedAt: '2026-01-05' },
  { author: 'Ava Sample', text: 'Hello there and greetings from a zeta fan', likes: 7, replyCount: 0, publishedAt: '2026-01-06' },
  { author: 'Bo Sample', text: 'How much zeta should I take each morning please?', likes: 6, replyCount: 2, publishedAt: '2026-01-06' },
  { author: 'Cy Sample', text: 'Where can I buy the zeta product you showed?', likes: 5, replyCount: 0, publishedAt: '2026-01-07' },
  { author: 'Di <Sample>', text: 'Is zeta safe to take with my other pills?', likes: 4, replyCount: 0, publishedAt: '2026-01-07' },
  { author: 'Ed Sample', text: 'Please refuse this synthetic zeta comment now', likes: 3, replyCount: 0, publishedAt: '2026-01-08' },
  { author: 'Fi Sample', text: 'Does zeta interact with coffee at all, doctor?', likes: 2, replyCount: 0, publishedAt: '2026-01-08' },
  { author: 'Gu Sample', text: 'One more synthetic comment past the limit here', likes: 1, replyCount: 0, publishedAt: '2026-01-09' },
];
vi.mock('child_process', async (orig) => {
  const real = await orig<typeof import('child_process')>();
  const spawnSync = (...a: unknown[]) => {
    spawnCalls.push(a);
    return { status: 0, stdout: 'human-readable list\n', stderr: `log line\n${JSON.stringify(COMMENTS)}` };
  };
  return { ...real, spawnSync, default: { ...real, spawnSync } };
});

class ExitCalled extends Error { constructor(public code: unknown) { super(`exit ${String(code)}`); } }
const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const text = (t: string, stop = 'end_turn') => ({ content: [{ type: 'thinking', thinking: 'x' }, { type: 'text', text: t }], stop_reason: stop });

function responder(url: string, init: RequestInit): Response {
  const body = JSON.parse(String(init.body));
  const user: string = body.messages[0].content;
  if (user.endsWith('Classification:')) {
    if (user.includes('Hello there')) return json(200, text('GREETING'));
    if (user.includes('buy the zeta')) return json(200, text('PRODUCT'));
    if (user.includes('Please refuse')) return json(200, { content: [], stop_reason: 'refusal' });
    if (user.includes('coffee')) return new Response('rate limited', { status: 429 });
    return json(200, text('ROUTE because it asks'));
  }
  if (user.startsWith('Current query:')) {
    if (user.includes('pills')) return json(200, text('not json at all'));
    if (user.includes('coffee')) return json(200, text('{"handles": []}'));
    return json(200, text('Here: {"handles": ["synthetic-zeta-guide", "NOT VALID", "unknown-handle", "synthetic-zeta-video"]}'));
  }
  if (user.includes('buy the zeta')) return json(200, text('SKIP_NO_REPLY'));
  if (user.includes('pills')) return new Response('server error body', { status: 500 });
  if (user.includes('coffee')) return json(200, text('  Synthetic <b>reply</b> & "quotes" about zeta.  '));
  return json(200, text('Synthetic reply about zeta.'));
}

let fetchCalls: { url: string; headers: unknown; summary: unknown }[];
let out: string[];
let writes: { file: string; data: string }[];
const savedArgv = process.argv;
const savedEnv = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  fetchCalls = []; out = []; writes = []; spawnCalls.length = 0;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_TEST_API_KEY;
  delete process.env.TOPIC_MASTER_HIDE;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    const sys = body.system as { text: string; cache_control?: unknown }[];
    fetchCalls.push({
      url, headers: init.headers,
      summary: {
        model: body.model, max_tokens: body.max_tokens, thinking: body.thinking, output_config: body.output_config,
        systemBlocks: sys.length, cached: sys.map(b => !!b.cache_control),
        platformHasBody: sys.some(b => b.text.includes(SYNTH_BODY)),
        matched: sys.find(b => b.text.startsWith('## Referenced Blog Articles'))?.text ?? null,
        user: body.messages[0].content,
      },
    });
    return responder(url, init);
  }));
  const realRead = fs.readFileSync;
  vi.spyOn(fs, 'readFileSync').mockImplementation(((p: fs.PathOrFileDescriptor, o?: unknown) =>
    String(p).endsWith(path.join('docs/blog', 'synthetic-zeta-video.md'))
      ? `---\ntitle: "Synthetic zeta video"\n---\n${SYNTH_BODY}\n`
      : realRead(p, o as BufferEncoding)) as typeof fs.readFileSync);
  vi.spyOn(fs, 'mkdirSync').mockImplementation((() => undefined) as typeof fs.mkdirSync);
  vi.spyOn(fs, 'writeFileSync').mockImplementation(((f: fs.PathOrFileDescriptor, d: unknown) => { writes.push({ file: String(f).replace(REPO_ROOT, '<repo>'), data: String(d) }); }) as typeof fs.writeFileSync);
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(`log: ${a.join(' ')}`); });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { out.push(`error: ${a.join(' ')}`); });
  vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { out.push(`warn: ${a.join(' ')}`); });
  vi.spyOn(process.stdout, 'write').mockImplementation(((s: string) => { out.push(`stdout: ${JSON.stringify(s)}`); return true; }) as typeof process.stdout.write);
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new ExitCalled(code); }) as typeof process.exit);
});

afterEach(() => {
  process.argv = savedArgv;
  process.env = { ...savedEnv };
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const run = (...cli: string[]) => {
  process.argv = ['node', 'tools/youtube-comment-dryrun.ts', ...cli];
  return import('./youtube-comment-dryrun');
};

describe('youtube-comment-dryrun pins (US-64 AC23)', () => {
  it('the module exports nothing', async () => {
    process.env.ANTHROPIC_TEST_API_KEY = 'stub';
    const mod = await run(VIDEO_ID, '--limit', '8', '--concurrency', '1');
    await vi.waitFor(() => expect(out.some(l => l.startsWith('log: Open with'))).toBe(true), { timeout: 20_000 });
    expect(Object.keys(mod)).toEqual([]);
  });

  it('a full run: stdout, every request, the shell-out and the written page', async () => {
    process.env.ANTHROPIC_TEST_API_KEY = 'stub';
    await run(`https://www.youtube.com/watch?v=${VIDEO_ID}&t=3`, '--limit', '8', '--concurrency', '1');
    await vi.waitFor(() => expect(out.some(l => l.startsWith('log: Open with'))).toBe(true), { timeout: 20_000 });
    expect(fetchCalls.every(c => c.url === 'https://api.anthropic.com/v1/messages')).toBe(true);
    expect(fetchCalls.every(c => (c.headers as Record<string, string>)['x-api-key'] === 'stub')).toBe(true);
    expect(process.exit).not.toHaveBeenCalled();
    expect({
      out: out.map(l => l.replace(REPO_ROOT, '<repo>')),
      spawn: spawnCalls.map(([cmd, argv]) => [cmd, argv]),
      requests: fetchCalls.map(c => c.summary),
      writes: writes.map(w => w.file),
    }).toMatchSnapshot();
    expect(writes).toHaveLength(1);
    expect(writes[0].data).toMatchSnapshot();
  });

  it('the production key line, a youtu.be URL and the default limit', async () => {
    process.env.ANTHROPIC_API_KEY = 'stub';
    await run(`https://youtu.be/${VIDEO_ID}`);
    await vi.waitFor(() => expect(out.some(l => l.startsWith('log: Open with'))).toBe(true), { timeout: 20_000 });
    expect(out.filter(l => l.startsWith('log: Using') || l.includes('Fetching comments') || l.includes('Running pipeline'))).toMatchSnapshot();
    expect(spawnCalls[0][1]).toEqual([expect.stringMatching(/youtube-analytics\.js$/), 'comments', VIDEO_ID, '--count', '50']);
  });

  it('no video argument: the usage line and exit 1, before any request', async () => {
    process.env.ANTHROPIC_TEST_API_KEY = 'stub';
    await expect(run('--concurrency=2')).rejects.toThrow('exit 1');
    expect(out).toEqual(['error: Usage: npx tsx tools/youtube-comment-dryrun.ts <videoUrlOrId> [--limit 50] [--concurrency 3]']);
    expect(fetchCalls).toEqual([]);
  });

  it('an unreadable video id throws before the key check; a flag value counts as the video', async () => {
    await expect(run('not a video')).rejects.toThrow('Could not extract video ID from: not a video');
    expect(out).toEqual([]);
    vi.resetModules();
    await expect(run('--limit', '3')).rejects.toThrow('Could not extract video ID from: 3');
    expect(out).toEqual([]);
  });

  it('no key: the key error and exit 1, before any request', async () => {
    await expect(run(`https://www.youtube.com/embed/${VIDEO_ID}`)).rejects.toThrow('exit 1');
    expect(out).toEqual(['error: Error: ANTHROPIC_TEST_API_KEY or ANTHROPIC_API_KEY must be set']);
    expect(fetchCalls).toEqual([]);
    expect(spawnCalls).toEqual([]);
  });
});

/**
 * US-63 AC13-AC15: tools/agent-channel.mjs `history` pages back without touching the read cursor, `read` and
 * `history` list attachments without URLs, and `fetch` downloads one text attachment from the CDN. Every test
 * drives run() with a mocked fetch (never the network), a temp HOME and a temp .env root, and checks what the
 * caller sees: exit code, stdout, stderr, the requests made, the state file and the saved file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { run, CHANNEL_KEY, GENERAL_PRIVATE_NOTE, TOKEN_KEY, UNTRUSTED_NOTE } from './agent-channel.mjs';
import { FILE_NOTE, MAX_DOWNLOAD, resolved } from './agent-channel-files.mjs';

const TOKEN = 'test-token-good';
const CHANNEL = '123456789012345678';
const HERMES = '400000000000000004';
const MSG_ID = '300000000000000010';
const ATT_ID = '700000000000000007';
const URL_ONLY = `https://discord.com/api/v10/channels/${CHANNEL}/messages`;
// Discord CDN URLs carry signed query parameters; this marker must never reach the caller.
const QUERY_MARK = 'sig-marker-q';
const cdn = (path = `/attachments/${CHANNEL}/${ATT_ID}/report.md`) => `https://cdn.discordapp.com${path}?ex=${QUERY_MARK}&hm=${QUERY_MARK}`;

let home: string;
let root: string;
let fetchMock: ReturnType<typeof vi.fn>;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const msg = (id: string, extra: Record<string, unknown> = {}) => ({ id, content: `m${id}`, timestamp: '2026-11-01T00:00:00Z', author: { id: HERMES, username: 'hermes', bot: true }, ...extra });
const att = (extra: Record<string, unknown> = {}) => ({ id: ATT_ID, filename: 'report.md', size: 11, content_type: 'text/markdown; charset=utf-8', url: cdn(), proxy_url: `https://media.discordapp.net/x?ex=${QUERY_MARK}`, ...extra });
// AC17's channel check (GET /channels/<id>) is answered here as a text channel, so fetchMock sees only the other requests.
const routed = (url: string, init: RequestInit) => (/\/channels\/\d+$/.test(url) ? json({ id: CHANNEL, guild_id: '100000000000000001', type: 0 }) : fetchMock(url, init));
const go = (argv: string[]) => run(argv, { env: {}, fetch: routed, home, root, now: () => Date.UTC(2026, 10, 1), stdin: async () => '' });
const statePath = () => join(home, '.health-roadmap', 'agent-channel-state.json');
const state = () => JSON.parse(readFileSync(statePath(), 'utf8'));
const urls = () => fetchMock.mock.calls.map((c) => String(c[0]));
const downloads = () => join(home, '.health-roadmap', 'agent-channel-downloads');
const saved = (name = 'report.md') => join(downloads(), `${MSG_ID}-${ATT_ID}-${name}`);

/** The API returns the message with this attachment; any other URL is the CDN, answering `cdnBody`. */
const serve = (extra: Record<string, unknown> = {}, cdnBody: () => Response = () => new Response('hello world')) =>
  fetchMock.mockImplementation(async (url: string) => (url === `${URL_ONLY}/${MSG_ID}` ? json(msg(MSG_ID, { attachments: [att(extra)] })) : cdnBody()));

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'agent-channel-home-'));
  root = mkdtempSync(join(tmpdir(), 'agent-channel-repo-'));
  writeFileSync(join(root, '.env'), `${TOKEN_KEY}=${TOKEN}\n${CHANNEL_KEY}=${CHANNEL}\n`);
  fetchMock = vi.fn(async () => json([]));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

describe('US-63 AC13: history pages backwards and never touches the read cursor', () => {
  it('leaves the cursor where read put it, so the next read asks for the same messages', async () => {
    fetchMock.mockResolvedValueOnce(json([msg('300000000000000050')]));
    await go(['read']);
    fetchMock.mockResolvedValueOnce(json([msg('300000000000000020'), msg('300000000000000010')]));
    const h = await go(['history', '--before', '300000000000000030']);
    expect(h.code).toBe(0);
    expect(state().cursor).toBe('300000000000000050');
    await go(['read']);
    expect(urls()[2]).toBe(`${URL_ONLY}?limit=50&after=300000000000000050`);
    expect(state()).toMatchObject({ reads: 2, history_reads: 1 });
  });
  it('run before any read, it sets no cursor: the first read still fetches only the latest N', async () => {
    fetchMock.mockResolvedValueOnce(json([msg('300000000000000020')]));
    await go(['history']);
    expect(state().cursor).toBe(null);
    await go(['read', '--limit', '5']);
    expect(urls()[1]).toBe(`${URL_ONLY}?limit=5`);
  });
  it('pages with --before and --limit, oldest first, untrusted, and names the oldest id for the next page', async () => {
    fetchMock.mockResolvedValueOnce(json([msg('300000000000000022'), msg('300000000000000021')]));
    const r = await go(['history', '--limit', '2', '--before', '300000000000000030']);
    expect(urls()[0]).toBe(`${URL_ONLY}?limit=2&before=300000000000000030`);
    const out = JSON.parse(r.stdout);
    expect(out).toMatchObject({ untrusted: true, note: UNTRUSTED_NOTE, oldest_id: '300000000000000021' });
    expect(out.messages.map((m: { id: string }) => m.id)).toEqual(['300000000000000021', '300000000000000022']);
    fetchMock.mockResolvedValueOnce(json([]));
    expect(JSON.parse((await go(['history', '--before', out.oldest_id])).stdout)).toMatchObject({ messages: [], oldest_id: null });
    expect(urls()[1]).toBe(`${URL_ONLY}?limit=50&before=300000000000000021`);
  });
  it('refuses a non-snowflake --before, a bad limit, a repeated or unknown flag, with nothing fetched', async () => {
    expect((await go(['history', '--before', '../../guilds/1'])).stderr).toContain('--before takes a Discord message id');
    for (const argv of [['history', '--limit', '101'], ['history', '--before', '300000000000000030', '--before', '300000000000000031'], ['history', '--after', '300000000000000030'], ['history', '--channel', CHANNEL], ['history', '--before'], ['read', '--before', '300000000000000030']]) {
      const r = await go(argv);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('usage');
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('US-63 AC14: read and history list attachments, never their URLs', () => {
  it('lists id, filename (control characters stripped, capped), size and content type; drops a bad id', async () => {
    const page = [msg(MSG_ID, { attachments: [att({ filename: `rep\u0007ort‮${'x'.repeat(300)}.md` }), att({ id: 'not-an-id' }), att({ id: '700000000000000008', size: 'big', content_type: undefined })] })];
    for (const cmd of ['read', 'history']) {
      fetchMock.mockResolvedValueOnce(json(page));
      const r = await go([cmd]);
      const [m] = JSON.parse(r.stdout).messages;
      expect(m.attachments).toEqual([
        { id: ATT_ID, filename: `report${'x'.repeat(194)}`, size: 11, content_type: 'text/markdown; charset=utf-8' },
        { id: '700000000000000008', filename: 'report.md', size: null, content_type: null },
      ]);
      expect(r.stdout).not.toContain('https://');
      expect(r.stdout).not.toContain(QUERY_MARK);
    }
  });
});

describe('US-63 AC15: fetch downloads one text attachment, its URL from the API only', () => {
  it('saves the file with mode 0600 in a 0700 folder and prints path, bytes and sha256, never the contents', async () => {
    serve();
    const r = await go(['fetch', MSG_ID, ATT_ID]);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out).toEqual({ untrusted: true, private: true, channel: 'agent', note: FILE_NOTE, private_note: GENERAL_PRIVATE_NOTE, path: saved(), bytes: 11, sha256: createHash('sha256').update('hello world').digest('hex') });
    expect(readFileSync(saved(), 'utf8')).toBe('hello world');
    expect(statSync(saved()).mode & 0o777).toBe(0o600);
    expect(statSync(downloads()).mode & 0o777).toBe(0o700);
    expect(readdirSync(downloads())).toEqual([basename(saved())]);
    expect(r.stdout).not.toContain('hello world');
    expect(state()).toMatchObject({ cursor: null, downloads: 1 });
  });
  it('sends the token to the API and no Authorization header to the CDN, with no redirect and a timeout', async () => {
    serve();
    await go(['fetch', MSG_ID, ATT_ID]);
    expect(urls()).toEqual([`${URL_ONLY}/${MSG_ID}`, cdn()]);
    const [[, api], [, cdnInit]] = fetchMock.mock.calls;
    expect(api.headers.Authorization).toBe(`Bot ${TOKEN}`);
    expect(cdnInit.headers?.Authorization).toBeUndefined();
    expect(JSON.stringify(cdnInit)).not.toContain(TOKEN);
    expect(cdnInit.redirect).toBe('error');
    expect(cdnInit.signal).toBeInstanceOf(AbortSignal);
  });
  it('refuses a URL off the CDN host, not https, with userinfo or a port, never printing the URL', async () => {
    const cases: [string, string][] = [
      ['https://evil.example/report.md', 'is not on cdn.discordapp.com'],
      ['https://cdn.discordapp.com.evil.example/report.md', 'is not on cdn.discordapp.com'],
      ['http://cdn.discordapp.com/report.md', 'is not https'],
      ['https://user:pw@cdn.discordapp.com/report.md', 'user name or password'],
      ['https://cdn.discordapp.com:8443/report.md', 'names a port'],
      ['https://cdn.discordapp.com:443/report.md', 'names a port'],
    ];
    for (const [base, reason] of cases) {
      fetchMock.mockClear();
      serve({ url: `${base}?ex=${QUERY_MARK}` });
      const r = await go(['fetch', MSG_ID, ATT_ID]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain(reason);
      expect(r.stderr).not.toContain(QUERY_MARK);
      expect(r.stderr).not.toContain(base);
      expect(urls()).toEqual([`${URL_ONLY}/${MSG_ID}`]);
    }
    expect(existsSync(downloads())).toBe(false);
  });
  it('refuses any extension but .md .txt .csv .json, case-insensitive', async () => {
    for (const filename of ['run.sh', 'report.md.exe', 'noext', 'report.html']) {
      fetchMock.mockClear();
      serve({ filename });
      expect((await go(['fetch', MSG_ID, ATT_ID])).stderr).toContain('only .md, .txt, .csv and .json');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
    serve({ filename: 'NOTES.TXT' });
    expect(JSON.parse((await go(['fetch', MSG_ID, ATT_ID])).stdout).path).toBe(saved('NOTES.txt'));
  });
  it('refuses a declared size over 2 MB, or none, before any download', async () => {
    serve({ size: MAX_DOWNLOAD + 1 });
    expect((await go(['fetch', MSG_ID, ATT_ID])).stderr).toContain(`declared size, ${MAX_DOWNLOAD + 1} bytes, is over the 2 MB cap`);
    fetchMock.mockClear();
    serve({ size: undefined });
    expect((await go(['fetch', MSG_ID, ATT_ID])).stderr).toContain('size is missing');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('stops reading once the bytes received pass 2 MB, and saves nothing', async () => {
    let pulls = 0;
    // 64 chunks of 64 KB (4 MB): finite, so a missing cap fails the test instead of hanging it.
    serve({}, () => new Response(new ReadableStream({ pull(c) { pulls += 1; if (pulls > 64) c.close(); else c.enqueue(new Uint8Array(64 * 1024)); } })));
    const r = await go(['fetch', MSG_ID, ATT_ID]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('over the 2 MB cap; nothing saved');
    expect(pulls).toBeLessThan(40); // 2 MB is 32 chunks; the rest is never read
    expect(readdirSync(downloads())).toEqual([]);
  });
  it('follows no redirect: a fetch that would follow one fails, and a 302 answer is refused', async () => {
    // Behaves as fetch does: follows a redirect unless told redirect: 'error', which rejects.
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      if (url === `${URL_ONLY}/${MSG_ID}`) return json(msg(MSG_ID, { attachments: [att()] }));
      if (init.redirect === 'error') throw new TypeError(`fetch failed ${url}`);
      return new Response('followed');
    });
    const a = await go(['fetch', MSG_ID, ATT_ID]);
    expect(a.stderr).toContain('could not download the attachment (TypeError)');
    expect(a.stderr).not.toContain(QUERY_MARK);
    serve({}, () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/x' } }));
    const b = await go(['fetch', MSG_ID, ATT_ID]);
    expect(b.stderr).toContain('redirect; not followed');
    expect(urls().filter((u) => !u.startsWith(URL_ONLY))).toEqual([cdn(), cdn()]);
    expect(existsSync(saved())).toBe(false);
  });
  it('never overwrites an existing file: refuses, naming the path, before downloading', async () => {
    mkdirSync(downloads(), { recursive: true });
    writeFileSync(saved(), 'earlier copy');
    serve();
    const r = await go(['fetch', MSG_ID, ATT_ID]);
    expect(r.stderr).toContain(`${saved()} already exists; not overwritten`);
    expect(readFileSync(saved(), 'utf8')).toBe('earlier copy');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('refuses an attachment id that is not on the message, or a message the API names differently', async () => {
    serve();
    expect((await go(['fetch', MSG_ID, '700000000000000099'])).stderr).toContain(`attachment 700000000000000099 is not on message ${MSG_ID}`);
    fetchMock.mockImplementation(async () => json(msg('300000000000000011', { attachments: [att()] })));
    expect((await go(['fetch', MSG_ID, ATT_ID])).stderr).toContain('is not on message');
    expect(urls().every((u) => u === `${URL_ONLY}/${MSG_ID}`)).toBe(true);
  });
  it('refuses ids that are not snowflakes, and a wrong argument count, with nothing fetched', async () => {
    for (const argv of [['fetch', 'abc', ATT_ID], ['fetch', MSG_ID, '../x'], ['fetch', MSG_ID], ['fetch', MSG_ID, ATT_ID, 'extra'], ['fetch', cdn(), ATT_ID]]) {
      const r = await go(argv);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('usage: fetch <message id> <attachment id>');
      expect(r.stderr).not.toContain(QUERY_MARK);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('a filename with ../, a leading dot or separators is saved inside the downloads folder under a safe name', async () => {
    const cases: [string, string][] = [['../../.bashrc.md', 'bashrc.md'], ['.hidden.txt', 'hidden.txt'], ['a/b\\c d.csv', 'abcd.csv'], ['...json', 'attachment.json']];
    for (const [filename, safe] of cases) {
      serve({ filename });
      const out = JSON.parse((await go(['fetch', MSG_ID, ATT_ID])).stdout);
      expect(out.path).toBe(saved(safe));
      expect(dirname(out.path)).toBe(downloads());
    }
    expect(readdirSync(downloads()).sort()).toEqual(cases.map(([, safe]) => basename(saved(safe))).sort());
    expect(readdirSync(home).sort()).toEqual(['.health-roadmap']);
  });
  it('no output or error carries the URL or its query string', async () => {
    const outputs: string[] = [];
    for (const answer of [() => new Response('ok'), () => new Response('no', { status: 403 }), () => { throw new TypeError(`fetch failed ${cdn()}`); }]) {
      rmSync(downloads(), { recursive: true, force: true });
      serve({}, answer);
      const r = await go(['fetch', MSG_ID, ATT_ID]);
      outputs.push(r.stdout + r.stderr);
    }
    expect(outputs[1]).toContain('the CDN answered HTTP 403');
    for (const o of outputs) {
      expect(o).not.toContain(QUERY_MARK);
      expect(o).not.toContain('cdn.discordapp.com/attachments');
    }
  });
});

describe('US-63 AC7/AC9: history and fetch check the state under the lock before any request', () => {
  const lock = () => join(home, '.health-roadmap', 'agent-channel-state.json.lock');
  for (const [name, plant, reason] of [
    ['a damaged state file', () => writeFileSync(statePath(), '{not json'), 'not a valid state file'],
    ['a non-integer downloads count', () => writeFileSync(statePath(), JSON.stringify({ cursor: null, post_times: [], downloads: 'x' })), 'not a valid state file'],
    ['a lock left by a stopped run', () => writeFileSync(lock(), 'crashed-owner'), 'delete it and try again'],
  ] as [string, () => void, string][]) {
    it(`${name} stops history and fetch with no request and no file`, async () => {
      mkdirSync(join(home, '.health-roadmap'), { recursive: true });
      plant();
      serve();
      for (const argv of [['history'], ['fetch', MSG_ID, ATT_ID]]) {
        const r = await go(argv);
        expect(r.code).toBe(1);
        expect(r.stderr).toContain(reason);
      }
      expect(fetchMock).not.toHaveBeenCalled();
      expect(existsSync(downloads())).toBe(false);
    }, 15_000);
  }
});

describe('US-63 AC16: the downloads folder is a real folder of ours, tightened to 0700, and capped', () => {
  it('refuses a symlinked folder, leaving its target and the target mode untouched', async () => {
    const target = mkdtempSync(join(tmpdir(), 'agent-channel-target-'));
    try {
      chmodSync(target, 0o755);
      writeFileSync(join(target, 'keep.txt'), 'theirs');
      mkdirSync(join(home, '.health-roadmap'), { recursive: true });
      symlinkSync(target, downloads());
      serve();
      const r = await go(['fetch', MSG_ID, ATT_ID]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('is not a real folder');
      expect(statSync(target).mode & 0o777).toBe(0o755);
      expect(readdirSync(target)).toEqual(['keep.txt']);
      expect(urls()).toEqual([`${URL_ONLY}/${MSG_ID}`]);
    } finally { rmSync(target, { recursive: true, force: true }); }
  });
  it('tightens an existing 0755 folder to 0700', async () => {
    mkdirSync(downloads(), { recursive: true });
    chmodSync(downloads(), 0o755);
    serve();
    expect((await go(['fetch', MSG_ID, ATT_ID])).code).toBe(0);
    expect(statSync(downloads()).mode & 0o777).toBe(0o700);
  });
  it('a file planted after the pre-check is not overwritten: the hard link refuses and no temp file stays', async () => {
    serve({}, () => { writeFileSync(saved(), 'planted'); return new Response('hello world'); });
    const r = await go(['fetch', MSG_ID, ATT_ID]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`${saved()} already exists; not overwritten`);
    expect(readFileSync(saved(), 'utf8')).toBe('planted');
    expect(readdirSync(downloads())).toEqual([basename(saved())]);
  });
  it('refuses at 50 files, naming the limit and no file, before downloading', async () => {
    mkdirSync(downloads(), { recursive: true });
    for (let i = 0; i < 50; i++) writeFileSync(join(downloads(), `old-${i}.md`), 'x');
    serve();
    const r = await go(['fetch', MSG_ID, ATT_ID]);
    expect(r.stderr).toContain('the limit is under 50 files and 60 MB. Remove old files from it by hand');
    expect(r.stderr).not.toContain('old-');
    expect(urls()).toEqual([`${URL_ONLY}/${MSG_ID}`]);
    rmSync(join(downloads(), 'old-0.md'));
    expect((await go(['fetch', MSG_ID, ATT_ID])).code).toBe(0);
  });
  it('refuses at 60 MB in total, before downloading', async () => {
    mkdirSync(downloads(), { recursive: true });
    writeFileSync(join(downloads(), 'big.txt'), Buffer.alloc(60 * 1024 * 1024));
    serve();
    expect((await go(['fetch', MSG_ID, ATT_ID])).stderr).toContain('Remove old files from it by hand');
    expect(urls()).toEqual([`${URL_ONLY}/${MSG_ID}`]);
  });
});

describe('US-63 AC16 (review R3): a missing path resolves whole, a relative one too', () => {
  it('keeps every character of a relative name whose parent is "."', () => {
    const cwd = realpathSync(process.cwd());
    expect(resolved('zz-agent-channel-missing')).toBe(join(cwd, 'zz-agent-channel-missing'));
    expect(resolved('zz-agent-channel-missing/a/b')).toBe(join(cwd, 'zz-agent-channel-missing', 'a', 'b'));
  });
  it('resolves an absolute missing path through its existing, symlinked ancestor', () => {
    const real = realpathSync(home);
    const link = join(root, 'link');
    symlinkSync(home, link);
    expect(resolved(join(link, 'x', 'y'))).toBe(join(real, 'x', 'y'));
  });
});

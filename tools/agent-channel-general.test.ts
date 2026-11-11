/**
 * US-63 AC1, AC2, AC17, AC19 (W-1, 2026-11-11): tools/agent-channel.mjs reads #general as well as the agent
 * channel, by name only, after checking each channel is a text channel in the same server. Every test drives
 * run() with a mocked fetch (never the network), a temp HOME and a temp .env root, and checks what the caller
 * sees: exit code, stdout, stderr, the requests made and the state file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, CHANNEL_KEY, GENERAL_KEY, PRIVATE_NOTE, TOKEN_KEY, UNTRUSTED_NOTE } from './agent-channel.mjs';
import { FILE_NOTE } from './agent-channel-files.mjs';

const TOKEN = 'test-token-good';
const AGENT = '123456789012345678';
const GENERAL = '223456789012345678';
const GUILD = '100000000000000001';
const HERMES = '400000000000000004';
const MSG_ID = '300000000000000010';
const ATT_ID = '700000000000000007';
const API = 'https://discord.com/api/v10';
const msgs = (id: string) => `${API}/channels/${id}/messages`;
const chan = (id: string) => `${API}/channels/${id}`;

let home: string;
let root: string;
let fetchMock: ReturnType<typeof vi.fn>;
/** Each channel's own answer to GET /channels/<id>, and its message page or single message. */
let channels: Record<string, unknown>;
let pages: Record<string, unknown>;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const msg = (id: string, extra: Record<string, unknown> = {}) => ({ id, content: `m${id}`, timestamp: '2026-11-01T00:00:00Z', author: { id: HERMES, username: 'hermes', bot: true }, ...extra });
const text = (id: string, extra: Record<string, unknown> = {}) => ({ id, guild_id: GUILD, type: 0, name: 'x', ...extra });
const writeEnv = (extra = `${GENERAL_KEY}=${GENERAL}\n`) => writeFileSync(join(root, '.env'), `${TOKEN_KEY}=${TOKEN}\n${CHANNEL_KEY}=${AGENT}\n${extra}`);
const go = (argv: string[], env: Record<string, string> = {}) => run(argv, { env, fetch: fetchMock, home, root, now: () => Date.UTC(2026, 10, 11), stdin: async () => '' });
const statePath = () => join(home, '.health-roadmap', 'agent-channel-state.json');
const state = () => JSON.parse(readFileSync(statePath(), 'utf8'));
const urls = () => fetchMock.mock.calls.map((c) => String(c[0]));

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'agent-channel-home-'));
  root = mkdtempSync(join(tmpdir(), 'agent-channel-repo-'));
  writeEnv();
  channels = { [AGENT]: text(AGENT), [GENERAL]: text(GENERAL) };
  pages = {};
  fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    const id = /\/channels\/(\d+)$/.exec(url)?.[1];
    if (id) return id in channels ? json(channels[id]) : json({ code: 10003, message: 'Unknown Channel' }, 404);
    if (init.method === 'POST') return json({ id: '200000000000000001' });
    const key = url.split('?')[0];
    return key in pages ? json(pages[key]) : json([]);
  });
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

describe('US-63 AC2: --channel names one of two fixed channels, never an id', () => {
  it('read --channel general checks both channels, then reads general only', async () => {
    pages[msgs(GENERAL)] = [msg('300000000000000002', { channel_id: GENERAL })];
    const r = await go(['read', '--channel', 'general', '--limit', '5']);
    expect(r.code).toBe(0);
    expect(urls()).toEqual([chan(GENERAL), chan(AGENT), `${msgs(GENERAL)}?limit=5`]);
    expect(JSON.parse(r.stdout).messages.map((m: { id: string }) => m.id)).toEqual(['300000000000000002']);
  });
  it('defaults to the agent channel, and --channel agent is the same', async () => {
    await go(['read']);
    await go(['history', '--channel', 'agent']);
    expect(urls()).toEqual([chan(AGENT), `${msgs(AGENT)}?limit=50`, chan(AGENT), `${msgs(AGENT)}?limit=50`]);
  });
  it('refuses a raw id, an unknown name, a prototype key, a repeated or empty flag, with no request', async () => {
    const cases = [
      ['read', '--channel', GENERAL], ['read', '--channel', AGENT], ['read', '--channel', 'nope'], ['read', '--channel', '__proto__'],
      ['history', '--channel', 'constructor'], ['read', '--channel', 'toString'], ['read', '--channel', 'General'],
      ['read', '--channel', 'general', '--channel', 'general'], ['history', '--channel', 'agent', '--channel', 'general'],
      ['fetch', '--channel', GENERAL, MSG_ID, ATT_ID], ['fetch', '--channel', 'general', '--channel', 'agent', MSG_ID, ATT_ID], ['read', '--channel'],
    ];
    for (const argv of cases) {
      const r = await go(argv);
      expect(r.code, argv.join(' ')).toBe(1);
      expect(r.stderr).toContain('usage');
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('post always goes to the agent channel and refuses --channel', async () => {
    expect((await go(['post', 'hello'])).code).toBe(0);
    const r = await go(['post', '--channel', 'general', 'hi']);
    expect(r.stderr).toContain('post takes no flags');
    expect(urls()).toEqual([msgs(AGENT)]);
  });
});

describe('US-63 AC1: DISCORD_AGENT_GENERAL_CHANNEL_ID, checked only when general is asked for', () => {
  const refuses = async (reason: string, env: Record<string, string> = {}) => {
    const r = await go(['read', '--channel', 'general'], env);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(GENERAL_KEY);
    expect(r.stderr).toContain(reason);
    expect(fetchMock).not.toHaveBeenCalled();
  };
  it('missing: general is refused, naming the variable; the agent channel still reads', async () => {
    writeEnv('');
    await refuses('is not set');
    expect((await go(['read'])).code).toBe(0);
  });
  it('not a Discord id', async () => {
    writeEnv(`${GENERAL_KEY}=../../guilds/1\n`);
    await refuses('is not a Discord channel id');
  });
  it('equal to the agent channel', async () => {
    writeEnv(`${GENERAL_KEY}=${AGENT}\n`);
    await refuses(`equals ${CHANNEL_KEY}`);
  });
  it('an environment value that differs from the .env, set or not there', async () => {
    await refuses('in the environment differs', { [GENERAL_KEY]: '323456789012345678' });
    writeEnv('');
    await refuses('in the environment differs', { [GENERAL_KEY]: GENERAL });
  });
});

describe('US-63 AC17: only a text channel in the same server is read', () => {
  const kinds: [string, Record<string, unknown>, string][] = [
    ['a DM', { type: 1, guild_id: undefined }, 'is a DM'],
    ['a group DM', { type: 3, guild_id: undefined }, 'is a DM'],
    ['a category', { type: 4 }, 'a category'],
    ['a forum', { type: 15 }, 'a forum'],
    ['a media channel', { type: 16 }, 'a media channel'],
    ['a voice channel', { type: 2 }, 'a voice channel'],
    ['a public thread', { type: 11 }, 'that is in a thread I cannot read'],
    ['a private thread', { type: 12 }, 'that is in a thread I cannot read'],
    ['a channel with no server', { guild_id: undefined }, 'is not in a server'],
    ['an answer for another id', { id: '323456789012345678' }, 'another channel id'],
  ];
  for (const [name, change, reason] of kinds) {
    it(`refuses ${name} for read, history and fetch, with no message request`, async () => {
      channels[GENERAL] = text(GENERAL, change);
      for (const argv of [['read', '--channel', 'general'], ['history', '--channel', 'general'], ['fetch', '--channel', 'general', MSG_ID, ATT_ID]]) {
        const r = await go(argv);
        expect(r.code).toBe(1);
        expect(r.stderr).toContain(reason);
      }
      expect(urls().every((u) => !u.includes('/messages'))).toBe(true);
    });
  }
  it('checks the agent channel too: a category there is refused', async () => {
    channels[AGENT] = text(AGENT, { type: 4 });
    expect((await go(['read'])).stderr).toContain('a category');
    expect(urls()).toEqual([chan(AGENT)]);
  });
  it('reads an announcement channel (type 5)', async () => {
    channels[GENERAL] = text(GENERAL, { type: 5 });
    expect((await go(['read', '--channel', 'general'])).code).toBe(0);
  });
  it("refuses #general in another server, and an unknown channel", async () => {
    channels[GENERAL] = text(GENERAL, { guild_id: '100000000000000002' });
    const r = await go(['read', '--channel', 'general']);
    expect(r.stderr).toContain('another server');
    delete channels[GENERAL];
    expect((await go(['read', '--channel', 'general'])).stderr).toContain('HTTP 404');
    expect(urls().every((u) => !u.includes('/messages'))).toBe(true);
  });
  it('drops a message from another channel in read and history; fetch refuses one', async () => {
    const page = [msg('300000000000000001', { channel_id: GENERAL }), msg('300000000000000002', { channel_id: AGENT }), msg('300000000000000003')];
    pages[msgs(GENERAL)] = page;
    for (const cmd of ['read', 'history']) {
      const out = JSON.parse((await go([cmd, '--channel', 'general'])).stdout);
      expect(out.messages.map((m: { id: string }) => m.id)).toEqual(['300000000000000001', '300000000000000003']);
    }
    pages[`${msgs(GENERAL)}/${MSG_ID}`] = msg(MSG_ID, { channel_id: AGENT, attachments: [] });
    const r = await go(['fetch', '--channel', 'general', MSG_ID, ATT_ID]);
    expect(r.stderr).toContain('in another channel');
    expect(urls().filter((u) => !u.startsWith(API))).toEqual([]);
  });
  it('a message Discord cannot find adds the thread hint', async () => {
    fetchMock.mockImplementationOnce(async () => json(text(GENERAL))).mockImplementationOnce(async () => json(text(AGENT)))
      .mockImplementationOnce(async () => json({ code: 10008, message: 'Unknown Message' }, 404));
    const r = await go(['fetch', '--channel', 'general', MSG_ID, ATT_ID]);
    expect(r.stderr).toContain('code 10008');
    expect(r.stderr).toContain('if it is in a thread, that is in a thread I cannot read');
  });
});

describe('US-63 AC17: one cursor per channel', () => {
  it('general moves cursors.general, agent moves cursor, and each next read asks after its own', async () => {
    pages[msgs(GENERAL)] = [msg('300000000000000009', { channel_id: GENERAL })];
    pages[msgs(AGENT)] = [msg('300000000000000004')];
    await go(['read', '--channel', 'general']);
    expect(state()).toMatchObject({ cursor: null, cursors: { general: '300000000000000009' } });
    await go(['read']);
    expect(state()).toMatchObject({ cursor: '300000000000000004', cursors: { general: '300000000000000009' } });
    pages[msgs(GENERAL)] = [];
    pages[msgs(AGENT)] = [];
    await go(['read', '--channel', 'general']);
    await go(['read']);
    const reads = urls().filter((u) => u.includes('/messages?'));
    expect(reads.slice(2)).toEqual([`${msgs(GENERAL)}?limit=50&after=300000000000000009`, `${msgs(AGENT)}?limit=50&after=300000000000000004`]);
  });
  it('history touches neither cursor', async () => {
    pages[msgs(GENERAL)] = [msg('300000000000000009', { channel_id: GENERAL })];
    await go(['history', '--channel', 'general']);
    expect(state()).toMatchObject({ cursor: null, cursors: {} });
  });
  it('a damaged cursors entry is a damaged state file: refused with no request', async () => {
    mkdirSync(join(home, '.health-roadmap'), { recursive: true });
    for (const cursors of [{ general: 'x' }, { other: null }, [], 'general', { general: 300000000000000009 }]) {
      writeFileSync(statePath(), JSON.stringify({ cursor: null, post_times: [], cursors }));
      const r = await go(['read', '--channel', 'general']);
      expect(r.stderr).toContain('not a valid state file');
    }
    writeFileSync(statePath(), '{"cursor":null,"post_times":[],"cursors":{"__proto__":{"general":"x"}}}');
    expect((await go(['read', '--channel', 'general'])).stderr).toContain('not a valid state file');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('US-63 AC19: every output is marked private and untrusted, naming its channel', () => {
  it('read, history and fetch carry untrusted, private, the channel and both notes', async () => {
    const att = { id: ATT_ID, filename: 'r.md', size: 2, content_type: 'text/markdown', url: `https://cdn.discordapp.com/attachments/x/r.md` };
    pages[`${msgs(GENERAL)}/${MSG_ID}`] = msg(MSG_ID, { channel_id: GENERAL, attachments: [att] });
    fetchMock.mockImplementation(async (url: string) => {
      const id = /\/channels\/(\d+)$/.exec(url)?.[1];
      if (id) return json(channels[id]);
      if (url.startsWith('https://cdn.discordapp.com/')) return new Response('hi');
      return json(pages[url.split('?')[0]] ?? []);
    });
    for (const [argv, note] of [[['read', '--channel', 'general'], UNTRUSTED_NOTE], [['history'], UNTRUSTED_NOTE], [['fetch', '--channel', 'general', MSG_ID, ATT_ID], FILE_NOTE]] as [string[], string][]) {
      const out = JSON.parse((await go(argv)).stdout);
      expect(out).toMatchObject({ untrusted: true, private: true, channel: argv.includes('general') ? 'general' : 'agent', note, private_note: PRIVATE_NOTE });
    }
    expect(PRIVATE_NOTE).toContain('nothing read goes into the repo, commits, PRs, issues, ledgers or posts');
  });
});

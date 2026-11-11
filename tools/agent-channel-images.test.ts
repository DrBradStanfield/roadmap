/**
 * US-63 AC15, AC16, AC18, AC19 (W-1, 2026-11-11): `fetch` saves PNG, JPEG, GIF and WebP images as well as text,
 * and the file's own bytes are the authority: the signature must match the extension, the header's dimensions
 * must parse and be 8192 or less, and Discord's declared metadata may not contradict them. Mocked fetch (never
 * the network), a temp HOME and a temp .env root; each test checks the exit code, stderr, the requests made and
 * the folder.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, CHANNEL_KEY, TOKEN_KEY } from './agent-channel.mjs';

const TOKEN = 'test-token-good';
const CHANNEL = '123456789012345678';
const MSG_ID = '300000000000000010';
const ATT_ID = '700000000000000007';
const API_MSG = `https://discord.com/api/v10/channels/${CHANNEL}/messages/${MSG_ID}`;
const CDN = 'https://cdn.discordapp.com/attachments/fixture/file';

// Real 1x1 PNG, GIF and lossy (VP8) WebP files, and a real 2x3 JPEG with an Exif block before its SOF (made with sips).
const b64 = (s: string) => Buffer.from(s, 'base64');
const REAL_PNG = b64('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==');
const REAL_GIF = b64('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7');
const REAL_WEBP = b64('UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAwA0JaQAA3AA/vuUAAA=');
const REAL_JPEG = b64(
  '/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAAqADAAQAAAABAAAAAwAAAAD/wAARCAADAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9sAQwACAgICAgIDAgIDBQMDAwUGBQUFBQYIBgYGBgYICggICAgICAoKCgoKCgoKDAwMDAwMDg4ODg4PDw8PDw8PDw8P/9sAQwECAgIEBAQHBAQHEAsJCxAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ/90ABAAB/9oADAMBAAIRAxEAPwDuKKKK/wBAD5c//9k=',
);

/** Header-only images: enough for the tool, which reads headers and never decodes pixels. */
const png = (w: number, h: number, pad = 0) => {
  const b = Buffer.alloc(33 + pad);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(b);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
};
const gif = (w: number, h: number) => { const b = Buffer.alloc(13); b.write('GIF89a', 0, 'latin1'); b.writeUInt16LE(w, 6); b.writeUInt16LE(h, 8); return b; };
const jpeg = (w: number, h: number) => Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 0xff, w >> 8, w & 0xff, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9]);
const webp = (chunk: string, fill: (b: Buffer) => void) => {
  const b = Buffer.alloc(30);
  b.write('RIFF', 0, 'latin1');
  b.writeUInt32LE(22, 4);
  b.write(`WEBP${chunk}`, 8, 'latin1');
  b.writeUInt32LE(10, 16);
  fill(b);
  return b;
};
const vp8x = (w: number, h: number) => webp('VP8X', (b) => { b.writeUIntLE(w - 1, 24, 3); b.writeUIntLE(h - 1, 27, 3); });
const vp8l = (w: number, h: number) => webp('VP8L', (b) => { b[20] = 0x2f; b.writeUInt32LE((((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14)) >>> 0, 21); });

let home: string;
let root: string;
let fetchMock: ReturnType<typeof vi.fn>;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const go = () => run(['fetch', MSG_ID, ATT_ID], { env: {}, fetch: fetchMock, home, root, now: () => Date.UTC(2026, 10, 11), stdin: async () => '' });
const downloads = () => join(home, '.health-roadmap', 'agent-channel-downloads');
const urls = () => fetchMock.mock.calls.map((c) => String(c[0]));

/** The channel check passes; the API returns the message with this attachment; the CDN answers `body`. */
function serve(filename: string, body: Buffer | string, extra: Record<string, unknown> = {}) {
  const size = Buffer.byteLength(body);
  const att = { id: ATT_ID, filename, size, url: `${CDN}?ex=q`, ...extra };
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string) => {
    if (url === `https://discord.com/api/v10/channels/${CHANNEL}`) return json({ id: CHANNEL, guild_id: '100000000000000001', type: 0 });
    if (url === API_MSG) return json({ id: MSG_ID, channel_id: CHANNEL, attachments: [att] });
    return new Response(body);
  });
}
/** Refused for `reason`, nothing saved; `downloaded` says whether the CDN was asked. */
async function refused(reason: string, downloaded: boolean) {
  const r = await go();
  expect(r.code, r.stdout).toBe(1);
  expect(r.stderr).toContain(reason);
  expect(urls().some((u) => u.startsWith(CDN))).toBe(downloaded);
  expect(existsSync(downloads()) ? readdirSync(downloads()) : []).toEqual([]);
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'agent-channel-home-'));
  root = mkdtempSync(join(tmpdir(), 'agent-channel-repo-'));
  writeFileSync(join(root, '.env'), `${TOKEN_KEY}=${TOKEN}\n${CHANNEL_KEY}=${CHANNEL}\n`);
  fetchMock = vi.fn();
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

describe('US-63 AC18: real images are saved', () => {
  const cases: [string, Buffer, string][] = [
    ['shot.png', REAL_PNG, 'image/png'], ['photo.jpg', REAL_JPEG, 'image/jpeg'], ['photo.JPEG', REAL_JPEG, 'image/jpeg'],
    ['anim.gif', REAL_GIF, 'image/gif'], ['pic.webp', REAL_WEBP, 'image/webp'],
  ];
  for (const [filename, bytes, type] of cases) {
    it(`saves ${filename} whose bytes, declared type and declared size agree`, async () => {
      const [width, height] = filename.startsWith('photo') ? [2, 3] : [1, 1];
      serve(filename, bytes, { content_type: type, width, height });
      const r = await go();
      expect(r.code, r.stderr).toBe(0);
      expect(readFileSync(JSON.parse(r.stdout).path)).toEqual(bytes);
    });
  }
  it('reads lossless (VP8L) and extended (VP8X) WebP headers', async () => {
    for (const bytes of [vp8l(640, 480), vp8x(8192, 1)]) {
      rmSync(downloads(), { recursive: true, force: true });
      serve('pic.webp', bytes);
      expect((await go()).code).toBe(0);
    }
  });
  it('absent metadata does not refuse: no content type, width or height', async () => {
    serve('shot.png', REAL_PNG);
    expect((await go()).code).toBe(0);
  });
  it('an image may be up to 8 MB, where text stops at 2 MB', async () => {
    serve('big.png', png(10, 10, 3 * 1024 * 1024));
    expect((await go()).code).toBe(0);
    rmSync(downloads(), { recursive: true, force: true });
    serve('big.png', png(10, 10), { size: 8 * 1024 * 1024 + 1 });
    await refused('over the 8 MB cap', false);
  });
});

describe('US-63 AC18: the header decides the dimensions, at most 8192 a side', () => {
  for (const [filename, bytes] of [['wide.png', png(9000, 10)], ['tall.gif', gif(10, 8193)], ['big.jpg', jpeg(8193, 8193)], ['big.webp', vp8x(9000, 2)], ['big2.webp', vp8l(10, 8200)], ['zero.png', png(0, 5)]] as [string, Buffer][]) {
    it(`refuses ${filename}`, async () => {
      serve(filename, bytes);
      await refused('each side must be 1 to 8192', true);
    });
  }
  for (const [filename, bytes] of [
    ['cut.png', png(1, 1).subarray(0, 20)], ['noihdr.png', Buffer.concat([png(1, 1).subarray(0, 12), Buffer.from('JUNK'), Buffer.alloc(17)])],
    ['sos.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xda, 0, 4, 0, 0])], ['junk.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 1, 7, 7])],
    ['odd.webp', webp('XXXX', () => {})], ['badvp8l.webp', webp('VP8L', () => {})], ['short.gif', Buffer.from('GIF89a')],
    // Codex R1: an IHDR chunk whose length is not 13, and one whose 13 bytes are not all there.
    ['len0.png', Buffer.from('89504e470d0a1a0a00000000494844520000000100000001', 'hex')],
    ['len14.png', (() => { const b = png(1, 1); b.writeUInt32BE(14, 8); return b; })()], ['cutihdr.png', png(1, 1).subarray(0, 28)],
  ] as [string, Buffer][]) {
    it(`refuses ${filename}: the header cannot be read`, async () => {
      serve(filename, bytes);
      await refused('header cannot be read', true);
    });
  }
  it('refuses a declared width or height that contradicts the header, after the download', async () => {
    serve('shot.png', REAL_PNG, { width: 5, height: 1 });
    await refused('declared width or height contradicts', true);
  });
  it('R2: the declared pair must equal the header, or the header swapped (an Exif-rotated photo)', async () => {
    for (const [filename, bytes, width, height] of [['photo.jpg', REAL_JPEG, 3, 2], ['tall.png', png(10, 20), 20, 10], ['tall.png', png(10, 20), 10, 20]] as [string, Buffer, number, number][]) {
      rmSync(downloads(), { recursive: true, force: true });
      serve(filename, bytes, { width, height });
      expect((await go()).code, filename).toBe(0);
    }
    rmSync(downloads(), { recursive: true, force: true });
    for (const [width, height] of [[3, 3], [2, 2], [20, 20]]) {
      serve('tall.png', png(10, 20), { width, height });
      await refused('declared width or height contradicts', true);
    }
  });
  it('refuses a declared side over 8192, or a declared type for another format, before any download', async () => {
    serve('shot.png', REAL_PNG, { width: 9000, height: 1 });
    await refused('declared width or height', false);
    serve('shot.png', REAL_PNG, { content_type: 'image/jpeg' });
    await refused('declared content type', false);
    serve('shot.png', REAL_PNG, { content_type: 'text/html' });
    await refused('declared content type', false);
  });
});

describe('US-63 AC18: disguised files are refused', () => {
  const html = Buffer.from('<!doctype html><script>x</script>');
  for (const [name, filename, body] of [
    ['an ELF binary named .png', 'shot.png', Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, ...Array(30).fill(0)])],
    ['an MZ binary named .png', 'shot.png', Buffer.from([0x4d, 0x5a, 0x90, 0, ...Array(40).fill(0)])],
    ['a ZIP named .jpg', 'photo.jpg', Buffer.from([0x50, 0x4b, 3, 4, ...Array(40).fill(0)])],
    ['HTML named .gif', 'anim.gif', html],
    ['a JPEG named .png', 'shot.png', REAL_JPEG],
    ['a PNG named .webp', 'pic.webp', REAL_PNG],
  ] as [string, string, Buffer][]) {
    it(`refuses ${name}`, async () => {
      serve(filename, body);
      await refused("bytes are not", true);
    });
  }
  it('refuses a .txt holding a NUL byte, and a .md that is not UTF-8', async () => {
    serve('notes.txt', Buffer.from('ok\u0000then'));
    await refused('NUL byte', true);
    serve('notes.md', Buffer.from([0x68, 0xc3, 0x28]));
    await refused('not valid UTF-8', true);
  });
  it('refuses a text file whose declared type is not text, before downloading', async () => {
    serve('notes.txt', 'hello', { content_type: 'image/png' });
    await refused('declared content type', false);
  });
  for (const filename of ['logo.svg', 'paper.pdf', 'bundle.zip', 'page.html', 'shot.png.exe']) {
    it(`refuses ${filename} by its extension, before downloading`, async () => {
      serve(filename, 'x');
      await refused('only .md, .txt, .csv and .json', false);
    });
  }
  it('refuses HEIC with the workaround', async () => {
    for (const filename of ['IMG_0001.HEIC', 'x.heif']) {
      serve(filename, 'x');
      await refused('resent as PNG or JPEG', false);
    }
  });
});

describe('US-63 AC16/AC19: the downloads folder never lands in a checkout', () => {
  it('refuses a HOME inside the main checkout, creating nothing there', async () => {
    home = join(root, 'home');
    mkdirSync(home);
    serve('shot.png', REAL_PNG);
    await refused('inside the git checkout', false);
    expect(existsSync(join(home, '.health-roadmap', 'agent-channel-downloads'))).toBe(false);
  });
  it('refuses a .health-roadmap folder that links into the checkout', async () => {
    mkdirSync(join(root, 'linked'));
    symlinkSync(join(root, 'linked'), join(home, '.health-roadmap'));
    serve('shot.png', REAL_PNG);
    await refused('inside the git checkout', false);
  });
  it('the folder cap is 60 MB', async () => {
    mkdirSync(downloads(), { recursive: true });
    writeFileSync(join(downloads(), 'big.bin'), Buffer.alloc(59 * 1024 * 1024));
    serve('shot.png', REAL_PNG);
    expect((await go()).code).toBe(0);
    writeFileSync(join(downloads(), 'big2.bin'), Buffer.alloc(1024 * 1024));
    serve('shot2.png', REAL_PNG);
    expect((await go()).stderr).toContain('the limit is under 50 files and 60 MB');
  });
});

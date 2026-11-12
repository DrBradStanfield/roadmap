/**
 * US-15 AC65: the set of server entries that reach a chat model call, pinned.
 * Each entry has its own missing-prompt guard (api.chat.ts chatAction,
 * app-routes.server.ts appChat, the Discord and YouTube start guards). A new
 * caller fails this pin, so its author has to answer: where is its guard?
 *
 * How it reads the source: every .ts/.tsx file under app/, minus tests
 * (*.test.ts, *.test.tsx, *.test-helpers.ts). A line counts as a call when it
 * names the function followed by "(" (webChatAction: any mention, as it is an
 * import alias); a line that defines it ("function name(") and comment lines
 * (starting with //, /* or *) do not count. tools/ is out of scope: those are
 * manual scripts with their own copies, never served.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return sources(p);
    if (!/\.tsx?$/.test(e.name) || /\.test(-helpers)?\.tsx?$/.test(e.name)) return [];
    return [p];
  });
}
const FILES = sources(join(ROOT, 'app')).map((p) => ({ path: relative(ROOT, p), lines: readFileSync(p, 'utf-8').split('\n') }));

function callers(name: string, call = true): string[] {
  const use = new RegExp(`\\b${name}${call ? '\\(' : '\\b'}`);
  const def = new RegExp(`function ${name}\\(`);
  return FILES.filter(({ lines }) => lines.some((l) => {
    const t = l.trim();
    return use.test(l) && !def.test(l) && !/^(\/\/|\/\*|\*)/.test(t);
  })).map((f) => f.path).sort();
}

const MODEL_CALLERS = ['app/lib/platform-chat.server.ts', 'app/lib/youtube-bot-pipeline.server.ts', 'app/routes/api.chat.ts'];

describe('US-15 AC65: chat model entries, pinned (add a missing-prompt guard before changing this list)', () => {
  it.each(['classifyMessage', 'routeQuery', 'getChatCompletion'])('%s( is called only by the three chat pipelines', (name) => {
    expect(callers(name)).toEqual(MODEL_CALLERS);
  });

  it('platformChatCompletion( is called only by the Discord bot', () => {
    expect(callers('platformChatCompletion')).toEqual(['app/lib/discord-bot.server.ts']);
  });

  it('runPipeline( is called only by the YouTube bot', () => {
    expect(callers('runPipeline')).toEqual(['app/lib/youtube-bot.server.ts']);
  });

  it('webChatAction (the web chat action reused) appears only in the iPhone routes', () => {
    expect(callers('webChatAction', false)).toEqual(['app/lib/app-routes.server.ts']);
  });

  it('the pin reads real source: it finds a definition file it then excludes', () => {
    expect(FILES.some((f) => f.path === 'app/lib/chat.server.ts' && f.lines.some((l) => /function getChatCompletion\(/.test(l)))).toBe(true);
  });
});

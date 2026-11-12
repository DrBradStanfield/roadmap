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
 * (starting with //, /* or *) do not count. A file also counts when it imports
 * a guarded name from its defining module under any alias (named, default,
 * namespace, dynamic or re-export). A file that re-exports a name, under any alias,
 * becomes a source of that alias too, through chains of re-exports.
 *
 * This pin is a best-effort early warning, not the guard. The guards are the
 * three production checks: chatAction's prompt check (api.chat.ts), appChat's
 * first-line check (app-routes.server.ts) and the getChatCompletion throw
 * (chat.server.ts). The scan does not normalise `.js`-suffixed specifiers or
 * `app/`-rooted and other non-relative paths (lead H68: an AST import walk).
 *
 * Gap it does not close: a NEW export in a listed file that wraps a guarded
 * call (`export const ask = (p) => getChatCompletion(p)` in api.chat.ts), or
 * re-exports a local import with a bare `export { name }`, gives the call a
 * new name this scan never sees. Whoever reviews a change to a listed file
 * checks for that. tools/ is out of scope: those are manual scripts with
 * their own copies, never served.
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
type Source = { path: string; lines: string[] };
const FILES: Source[] = sources(join(ROOT, 'app')).map((p) => ({ path: relative(ROOT, p), lines: readFileSync(p, 'utf-8').split('\n') }));

function callers(name: string, call = true, files: Source[] = FILES): string[] {
  const use = new RegExp(`\\b${name}${call ? '\\(' : '\\b'}`);
  const def = new RegExp(`function ${name}\\(`);
  return files.filter(({ lines }) => lines.some((l) => {
    const t = l.trim();
    return use.test(l) && !def.test(l) && !/^(\/\/|\/\*|\*)/.test(t);
  })).map((f) => f.path).sort();
}

// Each guarded name and the module that defines it (path without extension).
const DEFINED_IN: Record<string, string> = {
  classifyMessage: 'app/lib/chat-classifier.server',
  routeQuery: 'app/lib/chat-router.server',
  getChatCompletion: 'app/lib/chat.server',
  platformChatCompletion: 'app/lib/platform-chat.server',
  runPipeline: 'app/lib/youtube-bot-pipeline.server',
  action: 'app/routes/api.chat',
};

/** One import or re-export edge; each name is [name in the source module, name it takes here]. */
type Import = { file: string; from: string; names: Array<[string, string]> | '*'; reexport: boolean };
const NAMED = /\b(import|export)\s+(?:type\s+)?(?:(\w+)\s*,\s*)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;
const DEFAULT = /\bimport\s+(?!type\s)(\w+)\s+from\s*['"]([^'"]+)['"]/g;
const WHOLE = /\b(import\s+\*\s+as\s+\w+\s+from|export\s+\*\s+(?:as\s+\w+\s+)?from|import\()\s*['"`]([^'"`]+)['"`]/g;

function imports(files: Source[]): Import[] {
  return files.flatMap((f) => {
    const text = f.lines.join('\n');
    const at = (spec: string) => (spec.startsWith('.') ? join(dirname(f.path), spec).replace(/\.tsx?$/, '') : spec);
    const named = [...text.matchAll(NAMED)].map((m) => ({
      file: f.path, from: at(m[4]), reexport: m[1] === 'export',
      names: [
        ...(m[2] ? [['default', m[2]] as [string, string]] : []),
        ...m[3].split(',').map((n) => n.trim().replace(/^type\s+/, '')).filter(Boolean)
          .map((n) => { const [orig, alias] = n.split(/\s+as\s+/); return [orig, alias ?? orig] as [string, string]; }),
      ],
    }));
    const defaults = [...text.matchAll(DEFAULT)].map((m) => ({ file: f.path, from: at(m[2]), reexport: false, names: [['default', m[1]] as [string, string]] }));
    const whole = [...text.matchAll(WHOLE)].map((m) => ({ file: f.path, from: at(m[2]), reexport: m[1].startsWith('export'), names: '*' as const }));
    return [...named, ...defaults, ...whole];
  });
}

/**
 * Files that import the name from its defining module, or from any file that
 * re-exports it under any alias, through chains of re-exports. `provides` maps
 * a module to the names it exports the guarded function under; it grows until
 * no re-export adds a new one.
 */
function importers(name: string, files: Source[] = FILES): string[] {
  const all = imports(files);
  const provides = new Map<string, Set<string>>([[DEFINED_IN[name], new Set([name])]]);
  const taken = (i: Import): string[] => {
    const names = provides.get(i.from);
    if (!names) return [];
    return i.names === '*' ? [...names] : i.names.filter(([orig]) => names.has(orig)).map(([, alias]) => alias);
  };
  for (let grew = true; grew;) {
    grew = false;
    for (const i of all.filter((x) => x.reexport)) {
      const mod = i.file.replace(/\.tsx?$/, '');
      const names = provides.get(mod) ?? new Set<string>();
      for (const n of taken(i)) if (!names.has(n)) { names.add(n); grew = true; }
      if (names.size) provides.set(mod, names);
    }
  }
  return all.filter((i) => taken(i).length > 0).map((i) => i.file);
}

/** Every file that calls the name or imports it from its source, under any alias. */
function entries(name: string, files: Source[] = FILES): string[] {
  const local = name === 'action' ? callers('webChatAction', false, files) : callers(name, true, files);
  return [...new Set([...local, ...importers(name, files)])].sort();
}

const MODEL_CALLERS = ['app/lib/platform-chat.server.ts', 'app/lib/youtube-bot-pipeline.server.ts', 'app/routes/api.chat.ts'];

describe('US-15 AC65: chat model entries, pinned (add a missing-prompt guard before changing this list)', () => {
  it.each(['classifyMessage', 'routeQuery', 'getChatCompletion'])('%s is called or imported only by the three chat pipelines', (name) => {
    expect(entries(name)).toEqual(MODEL_CALLERS);
  });

  it('platformChatCompletion is called or imported only by the Discord bot', () => {
    expect(entries('platformChatCompletion')).toEqual(['app/lib/discord-bot.server.ts']);
  });

  it('runPipeline is called or imported only by the YouTube bot', () => {
    expect(entries('runPipeline')).toEqual(['app/lib/youtube-bot.server.ts']);
  });

  it('the web chat action (webChatAction) is reused or imported only by the iPhone routes', () => {
    expect(entries('action')).toEqual(['app/lib/app-routes.server.ts']);
  });

  it('a renamed import is still caught (NB1)', () => {
    const fake: Source[] = [
      { path: 'app/lib/new-bot.server.ts', lines: ["import { getChatCompletion as answer } from './chat.server';", 'answer(params);'] },
      { path: 'app/lib/new-route.server.ts', lines: ["import { action as x } from '../routes/api.chat';", 'x(args);'] },
      { path: 'app/lib/relay.server.ts', lines: ["export { getChatCompletion as complete } from './chat.server';"] },
      { path: 'app/lib/via-relay.server.ts', lines: ["import * as relay from './relay.server';", 'relay.complete(params);'] },
    ];
    // The name-only matcher misses both files; the import scan finds them.
    expect(callers('getChatCompletion', true, fake)).toEqual([]);
    expect(callers('webChatAction', false, fake)).toEqual([]);
    expect(entries('getChatCompletion', fake)).toEqual(['app/lib/new-bot.server.ts', 'app/lib/relay.server.ts', 'app/lib/via-relay.server.ts']);
    expect(entries('action', fake)).toEqual(['app/lib/new-route.server.ts']);
  });

  it('a renamed re-export imported by name, a chain of re-exports and a template dynamic import are caught (R2)', () => {
    const fake: Source[] = [
      { path: 'app/lib/youtube-bot.server.ts', lines: ["export { runPipeline as answer } from './youtube-bot-pipeline.server';"] },
      { path: 'app/routes/new-route.ts', lines: ["import { answer } from '../lib/youtube-bot.server';", 'answer(args);'] },
      { path: 'app/lib/hop1.server.ts', lines: ["export { getChatCompletion as a } from './chat.server';"] },
      { path: 'app/lib/hop2.server.ts', lines: ["export { a as b } from './hop1.server';"] },
      { path: 'app/lib/hop3.server.ts', lines: ["export * from './hop2.server';"] },
      { path: 'app/lib/end.server.ts', lines: ["import { b as go } from './hop3.server';", 'go(params);'] },
      { path: 'app/lib/lazy.server.ts', lines: ['const m = await import(`./chat.server`);'] },
    ];
    expect(entries('runPipeline', fake)).toEqual(['app/lib/youtube-bot.server.ts', 'app/routes/new-route.ts']);
    expect(entries('getChatCompletion', fake)).toEqual([
      'app/lib/end.server.ts', 'app/lib/hop1.server.ts', 'app/lib/hop2.server.ts', 'app/lib/hop3.server.ts', 'app/lib/lazy.server.ts',
    ]);
  });

  it('a default re-export taken by a default import is caught (R3)', () => {
    const fake: Source[] = [
      { path: 'app/lib/youtube-bot.server.ts', lines: ["export { runPipeline as default } from './youtube-bot-pipeline.server';"] },
      { path: 'app/routes/new-route.ts', lines: ["import answer from '../lib/youtube-bot.server';", 'answer(args);'] },
      { path: 'app/routes/mixed-route.ts', lines: ["import go, { other } from '../lib/youtube-bot.server';", 'go(args);'] },
    ];
    expect(entries('runPipeline', fake)).toEqual(['app/lib/youtube-bot.server.ts', 'app/routes/mixed-route.ts', 'app/routes/new-route.ts']);
  });

  it('the pin reads real source: it finds a definition file it then excludes', () => {
    expect(FILES.some((f) => f.path === 'app/lib/chat.server.ts' && f.lines.some((l) => /function getChatCompletion\(/.test(l)))).toBe(true);
  });
});

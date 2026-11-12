// US-67 AC2, Decision Q6 (Fable 2026-11-12): the chat shown and its turns have one writer, the
// chat-turn reducer's pure `transition`, and only the chat store (hooks/chatStore.ts) calls it.
// A second writer (a setter, a ref copy, an effect syncing state into a ref) lets an async step
// read a chat the person already left, which is the bug the reducer closed.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const dir = fileURLToPath(new URL('.', import.meta.url));
const lib = fileURLToPath(new URL('../lib/', import.meta.url));
const comps = fileURLToPath(new URL('../components/', import.meta.url));
const source = (folder: string) => readdirSync(folder)
  .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))
  .map((f) => ({ file: f, lines: readFileSync(folder + f, 'utf8').split('\n') }));
const files = [...source(dir), ...source(lib), ...source(comps)];
const hits = (pattern: RegExp) => files.flatMap(({ file, lines }) => lines.filter((l) => pattern.test(l)).map((l) => `${file}: ${l.trim()}`));

it('US-67 AC2: only chatStore.ts calls transition from chat-turn', () => {
  const importers = files.filter(({ lines }) => lines.some((l) => /from '@roadmap\/health-core\/chat-turn'/.test(l) && /\btransition\b/.test(l)));
  expect(importers.map((f) => f.file)).toEqual(['chatStore.ts']);
  expect(hits(/import \* as \w+ from '@roadmap\/health-core\/chat-turn'/)).toEqual([]);
});

it('US-67 AC2: nothing else assigns the turns or the chat shown', () => {
  expect(hits(/setMessages\(|setShownChat\(|messagesRef\.current\s*=[^=]|shownChatRef\.current\s*=[^=]|setSendingChat\(|setIsLocalSender\(/)).toEqual([]);
  expect(files.some(({ file }) => file === 'useShownChat.ts')).toBe(false);
});

// US-67 AC2 (Fable 2026-11-12, Codex R1): the chat shown has one writer, openChat, which sets
// the ref a landing reply reads and the state in the same call. A second writer, or an effect
// copying the state into the ref, lets a reply read a chat the person already left.
// The turns shown have one writer too, showMessages, which sets their ref and state in the same
// call: a write that set only one would let an async step read turns the screen no longer shows.
// Both live in useShownChat.ts; useChatState.ts holds no setter or ref write of its own.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const read = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8').split('\n');
const shown = read('./useShownChat.ts');
const state = read('./useChatState.ts');
const writers = (lines: string[], pattern: RegExp) => lines.filter((line) => pattern.test(line));

it('US-67 AC2: openChat is the only line that writes the shown chat', () => {
  const chat = /setShownChat\(|shownChatRef\.current\s*=[^=]/;
  expect(writers(state, chat)).toEqual([]);
  expect(writers(shown, chat)).toHaveLength(1);
  expect(writers(shown, chat)[0]).toMatch(/const openChat = useCallback/);
});

it('US-67 AC2: showMessages is the only line that writes the turns shown', () => {
  const turns = /setMessages\(|messagesRef\.current\s*=[^=]/;
  expect(writers(state, turns)).toEqual([]);
  expect(writers(shown, turns)).toHaveLength(1);
  expect(writers(shown, turns)[0]).toMatch(/const showMessages = useCallback/);
});

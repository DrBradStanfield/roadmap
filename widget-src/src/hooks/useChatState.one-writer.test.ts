// US-67 AC2 (Fable 2026-11-12, Codex R1): the chat shown has one writer, openChat, which sets
// the ref a landing reply reads and the state in the same call. A second writer, or an effect
// copying the state into the ref, lets a reply read a chat the person already left.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const source = readFileSync(fileURLToPath(new URL('./useChatState.ts', import.meta.url)), 'utf8');

it('US-67 AC2: openChat is the only line that writes the shown chat', () => {
  const writers = source.split('\n').filter((line) => /setShownChat\(|shownChatRef\.current\s*=[^=]/.test(line));
  expect(writers).toHaveLength(1);
  expect(writers[0]).toMatch(/const openChat = useCallback/);
});

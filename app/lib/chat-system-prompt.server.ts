/**
 * The chat system prompt (app/lib/chat-system-prompt.md), read once at import.
 * One state for the process: 'loaded' carries the text, 'missing' carries none,
 * so no caller can build a prompt without narrowing first (US-15 AC65).
 * On 'missing' the web and iPhone chat answer 503, the Discord and YouTube bots
 * do not start, getChatCompletion throws and /healthz answers 503.
 */
import * as Sentry from '@sentry/react-router';
import fs from 'fs';
import path from 'path';

export type ChatPromptState = { kind: 'loaded'; text: string } | { kind: 'missing' };

/** Absent, unreadable or blank after trim is 'missing'. */
export function loadChatPrompt(read: () => string): ChatPromptState {
  try {
    const text = read();
    return text.trim() ? { kind: 'loaded', text } : { kind: 'missing' };
  } catch {
    return { kind: 'missing' };
  }
}

export const CHAT_PROMPT: ChatPromptState = loadChatPrompt(
  () => fs.readFileSync(path.join(process.cwd(), 'app/lib/chat-system-prompt.md'), 'utf-8'),
);

// Fixed words only: no file content, no error object.
if (CHAT_PROMPT.kind === 'missing') {
  console.error('CHAT PROMPT MISSING: app/lib/chat-system-prompt.md is missing or empty; chat is off');
  Sentry.captureMessage('Chat system prompt missing', { level: 'error', tags: { feature: 'chat', subsystem: 'system-prompt' } });
}

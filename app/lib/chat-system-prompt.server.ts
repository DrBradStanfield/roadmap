/**
 * The chat docs, read once at import: the system prompt, the algorithm, the
 * products doc and both surface postures (CHAT_DOC_FILES). One state for the
 * process: 'loaded' carries every text, 'missing' names the files and carries
 * none, so no caller can build a prompt without narrowing first (US-15 AC65,
 * AC72). On 'missing' the web and iPhone chat answer 503, the Discord and
 * YouTube bots do not start and getChatCompletion throws: no model call.
 * /healthz ignores it.
 */
import * as Sentry from '@sentry/react-router';
import fs from 'fs';
import path from 'path';
import { PRODUCTS_BLOCK_FILES } from './chat-products-block';

/** Every file chat answers from. Absent, unreadable or blank after trim turns chat off. */
const CHAT_DOC_FILES = {
  text: 'app/lib/chat-system-prompt.md',
  algorithm: 'health_roadmap_algorithm.md',
  products: PRODUCTS_BLOCK_FILES.products,
  doctorPosture: 'app/lib/chat-posture-doctor.md',
  brandPosture: 'app/lib/chat-posture-brand.md',
} as const;

type ChatDocs = Record<keyof typeof CHAT_DOC_FILES, string>;
export type ChatPromptState = ({ kind: 'loaded' } & ChatDocs) | { kind: 'missing'; files: string[] };

export function loadChatPrompt(read: (file: string) => string): ChatPromptState {
  const docs: Partial<ChatDocs> = {};
  const files: string[] = [];
  for (const [key, file] of Object.entries(CHAT_DOC_FILES) as [keyof ChatDocs, string][]) {
    let text = '';
    try { text = read(file); } catch { /* absent or unreadable: missing */ }
    if (text.trim()) docs[key] = text;
    else files.push(file);
  }
  return files.length ? { kind: 'missing', files } : { kind: 'loaded', ...(docs as ChatDocs) };
}

export const CHAT_PROMPT: ChatPromptState = loadChatPrompt(
  (file) => fs.readFileSync(path.join(process.cwd(), file), 'utf-8'),
);

// File names only: no file content, no error object.
if (CHAT_PROMPT.kind === 'missing') {
  const files = CHAT_PROMPT.files.join(', ');
  console.error(`CHAT DOCS MISSING: ${files} missing or empty; chat is off`);
  Sentry.captureMessage(`Chat docs missing: ${files}`, { level: 'error', tags: { feature: 'chat', subsystem: 'system-prompt' } });
}

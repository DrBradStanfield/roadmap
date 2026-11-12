import { CHAT_PROMPT } from '../lib/chat-system-prompt.server';

// Simple health check for Fly.io. Verifies the server can respond to HTTP.
// Does NOT check Supabase — transient DB issues should not trigger machine restarts.
// Fails only on a missing chat system prompt, fixed for the image's life, so a canary without it never takes traffic (US-15 AC65).
export async function loader() {
  if (CHAT_PROMPT.kind === 'missing') return Response.json({ status: 'chat-prompt-missing' }, { status: 503 });
  return Response.json({ status: 'ok' }, { status: 200 });
}

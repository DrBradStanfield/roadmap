#!/usr/bin/env node
// Is the OpenAI reviewer sign-in live on this machine? (US-32 AC38; plan
// docs/reviews/2026-10-01-chatgpt-reviewer-signin-plan.md §4.5.)
//
// Fly secrets cannot be read back, so this runs INSIDE the machine, where they
// live: start the machine, then
//   fly ssh console -a health-tool-edu -C "node /app/tools/mcp-reviewer-check.mjs"
// (the image's WORKDIR is /app, so the absolute path works from any shell cwd).
// It checks the three secrets have the shape the server accepts (a malformed
// one switches the form off), refreshes the reviewer token with the same
// client_id + client_secret call the server makes, and lists the app folder.
// It prints only "ok" or "fail": never a value, never a reason that holds one.
import { pathToFileURL } from 'node:url';

export async function check({ env = process.env, fetch = globalThis.fetch } = {}) {
  const user = env.MCP_REVIEWER_USERNAME;
  const hash = env.MCP_REVIEWER_PASSWORD_SHA256;
  const rt = env.MCP_REVIEWER_DROPBOX_RT;
  // The same shape test as reviewerConfigured() in app/lib/mcp-reviewer.server.ts.
  if (!user || user.includes('@') || !hash || !/^[0-9a-f]{64}$/.test(hash) || !rt) return 'fail';
  if (!env.DROPBOX_APP_KEY || !env.DROPBOX_APP_SECRET) return 'fail';
  try {
    const res = await fetch('https://api.dropboxapi.com/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: rt, client_id: env.DROPBOX_APP_KEY, client_secret: env.DROPBOX_APP_SECRET }),
      signal: AbortSignal.timeout(8000),
    });
    const access = res.ok ? (await res.json())?.access_token : null;
    if (typeof access !== 'string' || !access) return 'fail';
    const listed = await fetch('https://api.dropboxapi.com/2/files/list_folder', {
      method: 'POST',
      headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '' }),
      signal: AbortSignal.timeout(8000),
    });
    return listed.ok ? 'ok' : 'fail';
  } catch {
    return 'fail';
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  check().then((result) => {
    console.log(result);
    process.exit(result === 'ok' ? 0 : 1);
  });
}

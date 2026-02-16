import { json } from '@remix-run/node';

// Simple health check for Fly.io. Verifies the server can respond to HTTP.
// Does NOT check Supabase — transient DB issues should not trigger machine restarts.
export async function loader() {
  return json({ status: 'ok' }, { status: 200 });
}

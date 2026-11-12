// Simple health check for Fly.io. Verifies the server can respond to HTTP.
// Does NOT check Supabase — transient DB issues should not trigger machine restarts.
export async function loader() {
  return Response.json({ status: 'ok' }, { status: 200 });
}

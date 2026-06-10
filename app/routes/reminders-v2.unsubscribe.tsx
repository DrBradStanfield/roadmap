import type { ActionFunctionArgs, LoaderFunctionArgs } from '@remix-run/node';
import { deleteByToken } from '../lib/reminder-v2.server';

/**
 * One-click unsubscribe for v2 reminder emails (decision record §10 — THE
 * reason the capability token exists: clicked from an inbox where the user is
 * not cloud-authed, and it must work without any login).
 *
 *  - GET  ?token=…  → tiny confirm page (a bare link click shouldn't nuke the
 *    opt-in — mail scanners prefetch GETs).
 *  - POST ?token=…  → delete the opt-in row entirely. This is also the
 *    RFC 8058 List-Unsubscribe-Post target, so inbox-native "Unsubscribe"
 *    buttons work in one click.
 *
 * Unsubscribing DELETES the row — no suppression list, nothing retained. If
 * the user later reopens the app, the stale token 404s on the next schedule
 * push, the app clears it from their cloud file and shows the opt-in again
 * (re-subscribing requires a fresh explicit opt-in + provider proof).
 */

function page(title: string, body: string): Response {
  return new Response(
    `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${title}</title></head>
<body style="margin:0;padding:40px 16px;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:8px;padding:32px;text-align:center;">
    <h1 style="font-size:20px;color:#1a1a1a;margin:0 0 16px;">${title}</h1>
    ${body}
  </div>
</body></html>`,
    { headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  );
}

export async function loader({ request }: LoaderFunctionArgs) {
  const token = new URL(request.url).searchParams.get('token');
  if (!token) return page('Link invalid', '<p style="color:#555;">This unsubscribe link is missing its token.</p>');
  return page(
    'Unsubscribe from health reminders?',
    `<p style="color:#555;font-size:15px;line-height:1.5;margin:0 0 24px;">
       You'll stop receiving reminder emails from Dr Brad's health plan tool.
       Your health data is unaffected — it lives only in your own cloud storage.
     </p>
     <form method="post">
       <button type="submit" style="background:#dc3545;color:#fff;border:none;border-radius:6px;padding:12px 28px;font-size:15px;font-weight:600;cursor:pointer;">
         Unsubscribe
       </button>
     </form>`,
  );
}

export async function action({ request }: ActionFunctionArgs) {
  const token = new URL(request.url).searchParams.get('token');
  if (!token) return page('Link invalid', '<p style="color:#555;">This unsubscribe link is missing its token.</p>');
  await deleteByToken(token); // idempotent — already-gone tokens land on the same page
  return page(
    "You're unsubscribed",
    `<p style="color:#555;font-size:15px;line-height:1.5;margin:0;">
       No more reminder emails will be sent to you. You can turn reminders back
       on anytime from the health plan tool.
     </p>`,
  );
}

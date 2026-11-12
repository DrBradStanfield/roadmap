/**
 * US-15 AC7e: what a server error may put in the Fly log. `safeErrorFields`
 * keeps a plain code and an HTTP status, never a message, details or hint.
 * Issue #927: a code made only of digits, past a 5-character SQLSTATE, is the
 * shape of a Shopify customer id and is refused. Issue #928: the server's
 * console.error/warn lines outside the guest path log `safeErrorFields`, never
 * the raw error, whose message can echo an id or an email.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { safeErrorFields } from './safe-error-fields.server';

describe('US-15 AC7e: safeErrorFields', () => {
  it('keeps a Postgres SQLSTATE, a PostgREST code and an auth code, with the status', () => {
    expect(safeErrorFields({ code: '23505', message: 'x' })).toEqual({ code: '23505' });
    expect(safeErrorFields({ code: 'PGRST116' })).toEqual({ code: 'PGRST116' });
    expect(safeErrorFields({ code: 'email_exists', status: 422 })).toEqual({ code: 'email_exists', status: 422 });
  });

  it('issue #927: refuses an all-digit code longer than a SQLSTATE, the shape of a Shopify customer id', () => {
    expect(safeErrorFields({ code: '7012345678901' })).toEqual({ code: 'unknown' });
    expect(safeErrorFields({ code: '123456' })).toEqual({ code: 'unknown' });
  });

  it('keeps the class name, never the message, and refuses a code that is not a plain identifier', () => {
    expect(safeErrorFields(new Error('synthetic failure for someone@example.invalid'))).toEqual({ name: 'Error', code: 'unknown' });
    expect(safeErrorFields(new TypeError('fetch failed'))).toEqual({ name: 'TypeError', code: 'unknown' });
    expect(safeErrorFields({ code: 'someone@example.invalid' })).toEqual({ code: 'unknown' });
    expect(safeErrorFields(null)).toEqual({ code: 'unknown' });
  });

  it('PR #1043 R1: refuses a name that is not a plain identifier, or is a long run of digits', () => {
    expect(safeErrorFields({ name: 'someone@example.invalid', code: '23505' })).toEqual({ code: '23505' });
    expect(safeErrorFields({ name: 'x'.repeat(41) })).toEqual({ code: 'unknown' });
    expect(safeErrorFields({ name: '7012345678901' })).toEqual({ code: 'unknown' });
  });
});

// Issue #928's sites. Each logged the raw error object to the Fly log. Not
// here: email.server.ts, whose thrown messages already pass through
// scrubText (email-error-scrub.test.ts), and admin-trigger.server.ts, whose
// log keeps the stack by design (admin-trigger.server.test.ts, ID-2).
const SITES = [
  'app/lib/supabase-account.server.ts',
  'app/lib/route-helpers.server.ts',
  'app/lib/klaviyo.server.ts',
  'app/lib/trending-cron.server.ts',
  'app/lib/reminder-v2-cron.server.ts',
  'app/lib/chat-purge-cron.server.ts',
  'app/lib/chat-question-archive.server.ts',
  'app/lib/discord-bot.server.ts',
  'app/lib/youtube-bot.server.ts',
  'app/routes/webhooks.orders-paid.ts',
  'app/routes/api.feedback.ts',
  'app/lib/supabase-dashboard.server.ts',
  'app/routes/api.measurements.ts',
  'app/lib/lab-extract-one.server.ts',
  'app/routes/api.lab-import-v2.ts',
];

describe('US-15 AC7e (issue #928): server logs name an error by safeErrorFields only', () => {
  it.each(SITES)('%s logs no raw error object', (file) => {
    const source = readFileSync(file, 'utf8');
    // A console.error/warn whose last argument is a bare error variable.
    const raw = source.match(/console\.(?:error|warn)\([^;]*?,\s*(?:error|err|e)\s*\)/g) ?? [];
    expect(raw).toEqual([]);
  });
});

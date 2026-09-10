/**
 * Resend failures are the one place an email send writes a recipient address
 * to stdout: the error is thrown, caught, and handed to `console.error`, which
 * on Fly is a log line. So neither our own message nor Resend's echoed text
 * may carry the address.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const send = vi.fn();
vi.mock('resend', () => ({ Resend: class { emails = { send }; } }));
vi.mock('./product-events.server', () => ({ recordServerEvent: vi.fn() }));
vi.mock('@sentry/react-router', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

process.env.RESEND_API_KEY = 'test-key';
const { sendEmail, sendReminderEmail, sendFeedbackEmail } = await import('./email.server');

const ADDRESS = 'someone.private@example.com';
/** Resend really does quote the address back in `message`. */
const rejection = {
  data: null,
  error: { name: 'validation_error', message: `Invalid \`to\` field: ${ADDRESS} is suppressed` },
};

let errors: string[];

beforeEach(() => {
  vi.clearAllMocks();
  errors = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '));
  });
});
afterEach(() => { vi.restoreAllMocks(); });

describe('a Resend failure never names the recipient', () => {
  it('keeps the address out of the thrown message, ours and Resend’s alike', async () => {
    send.mockResolvedValue(rejection);
    await expect(sendEmail(ADDRESS, 'subject', '<p>hi</p>')).rejects.toThrow(/validation_error/);
    await expect(sendEmail(ADDRESS, 'subject', '<p>hi</p>')).rejects.toSatisfy(
      (e: Error) => !e.message.includes(ADDRESS) && !e.message.includes('example.com') && e.message.includes('[email]'),
    );
  });

  it('says nothing about who the missing-id response was for', async () => {
    send.mockResolvedValue({ data: null, error: null });
    await expect(sendEmail(ADDRESS, 'subject', '<p>hi</p>')).rejects.toSatisfy(
      (e: Error) => !e.message.includes(ADDRESS),
    );
  });

  it('logs a reminder failure without the address', async () => {
    send.mockResolvedValue(rejection);
    expect(await sendReminderEmail(ADDRESS, '<p>due</p>', 'https://x/unsub')).toBe(false);
    expect(errors.join('\n')).not.toContain(ADDRESS);
    expect(errors.join('\n')).toContain('[email]');
  });

  it('logs a feedback failure without the sender’s address', async () => {
    send.mockResolvedValue(rejection);
    expect(await sendFeedbackEmail(ADDRESS, 'nice tool', null)).toBe(false);
    expect(errors.join('\n')).not.toContain(ADDRESS);
  });

  it('still sends to the real address — scrubbing is for the log, not the envelope', async () => {
    send.mockResolvedValue({ data: { id: 'msg_1' }, error: null });
    await sendEmail(ADDRESS, 'subject', '<p>hi</p>');
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ to: ADDRESS }));
  });
});

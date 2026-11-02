import { describe, it, expect } from 'vitest';
import { sendFeedbackEmail } from './email.server';

// ---------------------------------------------------------------------------
// Feedback email tests
// ---------------------------------------------------------------------------

describe('sendFeedbackEmail', () => {
  it('is callable and returns a boolean for guest user', async () => {
    const result = await sendFeedbackEmail('guest@example.com', 'Feedback from guest', null);
    expect(typeof result).toBe('boolean');
  });

  it('is callable and returns a boolean for logged-in user', async () => {
    const result = await sendFeedbackEmail('user@example.com', 'Feedback', '12345');
    expect(typeof result).toBe('boolean');
  });

  it('never throws even with empty inputs', async () => {
    // Should not throw — fire-and-forget pattern
    const result = await sendFeedbackEmail('', '', null);
    expect(typeof result).toBe('boolean');
  });
});

// @vitest-environment jsdom
/**
 * US-23 AC11 — the reminders control's marketing opt-in names the list it
 * joins. The typed address goes to the MicroVitamin mailing list
 * (api.reminders-v2 → subscribeToKlaviyo), so the box must say so and say
 * whose list it is, not promise "Dr Brad's health emails".
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup, act, waitFor } from '@testing-library/react';
import type { FileReminderOptIn } from '@roadmap/health-core/roadmap-file';
import { ERASE_IN_PROGRESS } from '@roadmap/health-core/erase';

// The record's opt-in, as the control reads it; a test sets it.
let recordOptIn: FileReminderOptIn | undefined;
const cancelReminders = vi.hoisted(() => vi.fn());
vi.mock('../src/lib/roadmap-data', () => ({ getReminderOptIn: () => recordOptIn }));
vi.mock('./reminders', () => ({
  cancelReminders,
  ENROL_NOTICE_KEY: 'hr_reminders_enrol_notice',
  optInToReminders: vi.fn(),
  ReminderEmailNeeded: class extends Error {},
  remindersSupported: () => true,
}));

import { RemindersControl } from './reminders-control';

afterEach(() => {
  cleanup();
  recordOptIn = undefined;
  cancelReminders.mockReset();
});

describe('US-23 AC11 — the reminders opt-in names the MicroVitamin mailing list', () => {
  const openStep = () => {
    const view = render(<RemindersControl backend="google-drive" />);
    fireEvent.click(view.getByRole('button', { name: 'Turn on email health reminders' }));
    return view;
  };

  it('the unticked box names the list and whose it is', () => {
    const view = openStep();
    const box = view.getByRole('checkbox') as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(box.closest('label')?.textContent).toBe(
      ' Also add me to the MicroVitamin mailing list (Dr Brad’s supplement company). Unsubscribe anytime.',
    );
    expect(view.container.textContent).not.toMatch(/evidence-based health emails/);
  });

  it('ticking it asks for the address for that list', () => {
    const view = openStep();
    fireEvent.click(view.getByRole('checkbox'));
    const input = view.getByRole('textbox', { name: 'Email for the MicroVitamin mailing list' }) as HTMLInputElement;
    expect(input.placeholder).toBe('Your email for the MicroVitamin list');
  });
});

describe('US-17 AC17: the control follows the record, and a refused Turn off says why', () => {
  const ACTIVE: FileReminderOptIn = {
    status: 'active', token: 'test-token-old', email: 'synthetic-person@example.com', provider: 'dropbox',
    updatedAt: '2026-11-14T00:00:00.000Z', lamport: 1,
  };

  it('another device turning reminders off, merged in, shows the off line', () => {
    recordOptIn = ACTIVE;
    const view = render(<RemindersControl backend="dropbox" />);
    expect(view.getByRole('button', { name: 'Turn off' })).toBeTruthy();
    recordOptIn = { ...ACTIVE, status: 'cancelled', lamport: 2 };
    act(() => { window.dispatchEvent(new Event('hr:remote-changed')); });
    expect(view.queryByRole('button', { name: 'Turn off' })).toBeNull();
    expect(view.getByRole('button', { name: 'Turn on email health reminders' })).toBeTruthy();
  });

  it('a Turn off refused by an erase in progress shows that message, and the switch stays on', async () => {
    recordOptIn = ACTIVE;
    cancelReminders.mockRejectedValue(new Error(ERASE_IN_PROGRESS));
    const view = render(<RemindersControl backend="dropbox" />);
    fireEvent.click(view.getByRole('button', { name: 'Turn off' }));
    await waitFor(() => expect(view.container.textContent).toContain(ERASE_IN_PROGRESS));
    expect(view.getByRole('button', { name: 'Turn off' })).toBeTruthy();
    expect(view.container.textContent).toContain('Email health reminders on');
  });
});

describe('US-17 AC19: the control shows every active address the record holds', () => {
  const row = (token: string, email: string, status: 'active' | 'cancelled', lamport: number) =>
    ({ status, token, email, provider: 'dropbox' as const, updatedAt: `2026-11-0${lamport}T00:00:00.000Z`, lamport });

  it('two active addresses: the on line names both, the shown one first, and one Turn off', () => {
    recordOptIn = { ...row('test-token-a', 'a@example.test', 'active', 2), tokens: [row('test-token-b', 'b@example.test', 'active', 1), row('test-token-c', 'c@example.test', 'cancelled', 3)] };
    const view = render(<RemindersControl backend="dropbox" />);
    expect(view.container.textContent).toContain('✓ Email health reminders on → a@example.test and b@example.test');
    expect(view.container.textContent).not.toContain('c@example.test');
    expect(view.getAllByRole('button', { name: 'Turn off' })).toHaveLength(1);
  });

  it('three: listed with commas and a last "and"; one address cased two ways is named once', () => {
    recordOptIn = { ...row('test-token-a', 'a@example.test', 'active', 4), tokens: [row('test-token-b', 'b@example.test', 'active', 1), row('test-token-c', 'c@example.test', 'active', 2), row('test-token-d', ' A@Example.test', 'active', 3)] };
    const view = render(<RemindersControl backend="dropbox" />);
    expect(view.container.textContent).toContain('✓ Email health reminders on → a@example.test, b@example.test and c@example.test');
  });

  it('an active row with no address string still shows on, naming the addresses it can (review C1)', () => {
    recordOptIn = { ...row('test-token-a', 'a@example.test', 'active', 2), email: null as unknown as string, tokens: [row('test-token-b', 'b@example.test', 'active', 1)] };
    const view = render(<RemindersControl backend="dropbox" />);
    expect(view.container.textContent).toContain('✓ Email health reminders on → b@example.test');
    cleanup();
    recordOptIn = { ...row('test-token-a', 'a@example.test', 'active', 2), email: null as unknown as string };
    const alone = render(<RemindersControl backend="dropbox" />);
    expect(alone.container.textContent).toContain('✓ Email health reminders onTurn off');
    expect(alone.getByRole('button', { name: 'Turn off' })).toBeTruthy();
  });

  it('a stored cancelled row over a nested active one shows on, with the active address', () => {
    recordOptIn = { ...row('test-token-a', 'a@example.test', 'cancelled', 2), tokens: [row('test-token-b', 'b@example.test', 'active', 1)] };
    const view = render(<RemindersControl backend="dropbox" />);
    expect(view.container.textContent).toContain('✓ Email health reminders on → b@example.test');
    expect(view.container.textContent).not.toContain('a@example.test');
  });
});

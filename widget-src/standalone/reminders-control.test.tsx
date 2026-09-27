// @vitest-environment jsdom
/**
 * US-23 AC11 — the reminders control's marketing opt-in names the list it
 * joins. The typed address goes to the MicroVitamin mailing list
 * (api.reminders-v2 → subscribeToKlaviyo), so the box must say so and say
 * whose list it is, not promise "Dr Brad's health emails".
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';

vi.mock('../src/lib/roadmap-data', () => ({ getReminderOptIn: () => undefined }));
vi.mock('./reminders', () => ({
  cancelReminders: vi.fn(),
  ENROL_NOTICE_KEY: 'hr_reminders_enrol_notice',
  optInToReminders: vi.fn(),
  ReminderEmailNeeded: class extends Error {},
  remindersSupported: () => true,
}));

import { RemindersControl } from './reminders-control';

afterEach(cleanup);

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

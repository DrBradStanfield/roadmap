// @vitest-environment jsdom
/**
 * US-17 AC18 (lead H116): what the person sees in the reminders control, flow
 * by flow, pinned through the rendered control before its five useStates
 * became one ToggleStep. Every word here is today's; the conversion changes
 * none of them. The last block pins four oddities the old state allowed, as
 * the owner ruled on them (2026-11-25).
 * Synthetic addresses only.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup, act, waitFor, type RenderResult } from '@testing-library/react';
import type { FileReminderOptIn } from '@roadmap/health-core/roadmap-file';

let recordOptIn: FileReminderOptIn | undefined;
const { cancelReminders, optInToReminders, ReminderEmailNeeded } = vi.hoisted(() => ({
  cancelReminders: vi.fn(),
  optInToReminders: vi.fn(),
  ReminderEmailNeeded: class extends Error {
    constructor() { super('We could not read the email on your cloud account — type the address reminders should go to.'); }
  },
}));
vi.mock('../src/lib/roadmap-data', () => ({ getReminderOptIn: () => recordOptIn }));
vi.mock('./reminders', () => ({
  cancelReminders,
  ENROL_NOTICE_KEY: 'hr_reminders_notice',
  optInToReminders,
  ReminderEmailNeeded,
  remindersSupported: () => true,
}));

import { RemindersControl } from './reminders-control';

const ADDRESS = 'synthetic-person@example.com';
const ACTIVE: FileReminderOptIn = {
  status: 'active', token: 'test-token-good', email: ADDRESS, provider: 'dropbox',
  updatedAt: '2026-11-25T00:00:00.000Z', lamport: 1,
};
const ON_LINE = `✓ Email health reminders on → ${ADDRESS}`;
const OFF_LINE = 'Get an email when a check-up or blood test comes due.';
const NEEDS_EMAIL = 'We could not read the email on your cloud account — type the address reminders should go to.';
const BAD_MARKETING = 'That email doesn’t look right — please check it (or untick the box).';
const BAD_REMINDER = 'That email doesn’t look right — please check it.';
const REFRESHED = `Reminders are already set up for ${ADDRESS} — we refreshed your schedule. To turn them off, use the link in any reminder email.`;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const button = (view: RenderResult, name: string) => view.getByRole('button', { name }) as HTMLButtonElement;
const text = (view: RenderResult) => view.container.textContent ?? '';
const open = () => {
  const view = render(<RemindersControl backend="dropbox" />);
  fireEvent.click(button(view, 'Turn on email health reminders'));
  return view;
};
/** The record turns on (as optInToReminders writes it), then the call answers. */
const enrols = () => optInToReminders.mockImplementation(async () => {
  recordOptIn = ACTIVE;
  return { email: ADDRESS, refreshed: false };
});
const changed = () => act(() => { window.dispatchEvent(new Event('hr:reminders-changed')); });

afterEach(() => {
  cleanup();
  recordOptIn = undefined;
  cancelReminders.mockReset();
  optInToReminders.mockReset();
});

describe('US-17 AC18: turn on', () => {
  it('the step opens unticked; while the call runs the button says Setting up… and is off; then the on line', async () => {
    const call = deferred<{ email: string; refreshed: boolean }>();
    optInToReminders.mockReturnValue(call.promise);
    const view = open();
    expect(text(view)).toContain('Reminders go to the email on your connected cloud account.');
    expect((view.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
    expect(view.queryByRole('textbox')).toBeNull();
    fireEvent.click(button(view, 'Turn on reminders'));
    await waitFor(() => expect(button(view, 'Setting up…').disabled).toBe(true));
    expect(button(view, 'Cancel').disabled).toBe(true);
    expect(optInToReminders).toHaveBeenCalledWith('dropbox', { marketingEmail: undefined, email: undefined });
    recordOptIn = ACTIVE;
    await act(async () => { call.resolve({ email: ADDRESS, refreshed: false }); });
    expect(text(view)).toContain(ON_LINE);
    expect(button(view, 'Turn off').disabled).toBe(false);
    expect(view.container.querySelector('.hr-sync-error')).toBeNull();
  });

  it('a ticked box sends the typed address, trimmed', async () => {
    enrols();
    const view = open();
    fireEvent.click(view.getByRole('checkbox'));
    fireEvent.change(view.getByRole('textbox', { name: 'Email for the MicroVitamin mailing list' }), { target: { value: '  list-person@example.com ' } });
    fireEvent.click(button(view, 'Turn on reminders'));
    await waitFor(() => expect(text(view)).toContain(ON_LINE));
    expect(optInToReminders).toHaveBeenCalledWith('dropbox', { marketingEmail: 'list-person@example.com', email: undefined });
  });

  it('a ticked box with a bad address: its message, the form kept as typed, nothing sent', async () => {
    const view = open();
    fireEvent.click(view.getByRole('checkbox'));
    fireEvent.change(view.getByRole('textbox', { name: 'Email for the MicroVitamin mailing list' }), { target: { value: 'not-an-address' } });
    fireEvent.click(button(view, 'Turn on reminders'));
    await waitFor(() => expect(text(view)).toContain(BAD_MARKETING));
    expect((view.getByRole('textbox', { name: 'Email for the MicroVitamin mailing list' }) as HTMLInputElement).value).toBe('not-an-address');
    expect(button(view, 'Turn on reminders').disabled).toBe(false);
    expect(optInToReminders).not.toHaveBeenCalled();
  });

  it('a failure says its message, or a plain retry line when it is not an Error; the step stays open', async () => {
    optInToReminders.mockRejectedValueOnce(new Error('Could not set up reminders (503).'));
    const view = open();
    fireEvent.click(button(view, 'Turn on reminders'));
    await waitFor(() => expect(text(view)).toContain('Could not set up reminders (503).'));
    optInToReminders.mockRejectedValueOnce('not an error');
    fireEvent.click(button(view, 'Turn on reminders'));
    await waitFor(() => expect(text(view)).toContain('Something went wrong — please retry.'));
    expect(text(view)).not.toContain('Could not set up reminders (503).');
    expect(button(view, 'Turn on reminders')).toBeTruthy();
  });

  it('Cancel closes the step and clears its message; it reopens empty', async () => {
    optInToReminders.mockRejectedValueOnce(new Error('Could not set up reminders (503).'));
    const view = open();
    fireEvent.click(view.getByRole('checkbox'));
    fireEvent.change(view.getByRole('textbox'), { target: { value: 'typed@example.com' } });
    fireEvent.click(button(view, 'Turn on reminders'));
    await waitFor(() => expect(text(view)).toContain('Could not set up reminders (503).'));
    fireEvent.click(button(view, 'Cancel'));
    expect(text(view)).toContain(OFF_LINE);
    expect(view.container.querySelector('.hr-sync-error')).toBeNull();
    fireEvent.click(button(view, 'Turn on email health reminders'));
    expect((view.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
    expect(view.queryByRole('textbox')).toBeNull();
  });
});

describe('US-17 AC18: the provider has no email to give', () => {
  it('asks for the address, checks it, sends it trimmed; the field is gone on the next opening', async () => {
    optInToReminders.mockRejectedValueOnce(new ReminderEmailNeeded());
    const view = open();
    fireEvent.click(button(view, 'Turn on reminders'));
    await waitFor(() => expect(text(view)).toContain(NEEDS_EMAIL));
    const field = view.getByRole('textbox', { name: 'Email for your reminders' }) as HTMLInputElement;
    expect(field.placeholder).toBe('Email for your reminders');
    fireEvent.change(field, { target: { value: 'nope' } });
    fireEvent.click(button(view, 'Turn on reminders'));
    await waitFor(() => expect(text(view)).toContain(BAD_REMINDER));
    expect(text(view)).not.toContain(NEEDS_EMAIL);
    expect(optInToReminders).toHaveBeenCalledTimes(1);
    enrols();
    fireEvent.change(view.getByRole('textbox', { name: 'Email for your reminders' }), { target: { value: ` ${ADDRESS} ` } });
    fireEvent.click(button(view, 'Turn on reminders'));
    await waitFor(() => expect(text(view)).toContain(ON_LINE));
    expect(optInToReminders).toHaveBeenLastCalledWith('dropbox', { marketingEmail: undefined, email: ADDRESS });
    cancelReminders.mockImplementation(async () => { recordOptIn = { ...ACTIVE, status: 'cancelled', lamport: 2 }; });
    fireEvent.click(button(view, 'Turn off'));
    await waitFor(() => expect(text(view)).toContain(OFF_LINE));
    fireEvent.click(button(view, 'Turn on email health reminders'));
    expect(view.queryByRole('textbox', { name: 'Email for your reminders' })).toBeNull();
  });
});

describe('US-17 AC18: an address already enrolled (refreshed, AC8)', () => {
  it('says so in place of the off line, with no button to turn on', async () => {
    optInToReminders.mockResolvedValue({ email: ADDRESS, refreshed: true });
    const view = open();
    fireEvent.click(button(view, 'Turn on reminders'));
    await waitFor(() => expect(text(view)).toContain(REFRESHED));
    expect(view.queryByRole('button')).toBeNull();
    expect(text(view)).not.toContain(OFF_LINE);
  });
});

describe('US-17 AC18: turn off', () => {
  it('while the cancel runs the button says Turning off… and is off; then the off line', async () => {
    recordOptIn = ACTIVE;
    const call = deferred<void>();
    cancelReminders.mockReturnValue(call.promise);
    const view = render(<RemindersControl backend="dropbox" />);
    expect(text(view)).toContain('What reaches Dr Brad’s server');
    fireEvent.click(button(view, 'Turn off'));
    await waitFor(() => expect(button(view, 'Turning off…').disabled).toBe(true));
    recordOptIn = { ...ACTIVE, status: 'cancelled', lamport: 2 };
    await act(async () => { call.resolve(); });
    expect(text(view)).toContain(OFF_LINE);
    expect(button(view, 'Turn on email health reminders').disabled).toBe(false);
  });

  it('a failed Turn off says its message, the switch on; the next try clears it first', async () => {
    recordOptIn = ACTIVE;
    cancelReminders.mockRejectedValueOnce(new Error('Could not turn off (500).'));
    const view = render(<RemindersControl backend="dropbox" />);
    fireEvent.click(button(view, 'Turn off'));
    await waitFor(() => expect(text(view)).toContain('Could not turn off (500).'));
    expect(text(view)).toContain(ON_LINE);
    const call = deferred<void>();
    cancelReminders.mockReturnValue(call.promise);
    fireEvent.click(button(view, 'Turn off'));
    await waitFor(() => expect(text(view)).not.toContain('Could not turn off (500).'));
    await act(async () => { call.resolve(); });
  });
});

describe('US-17 AC18: what the old state allowed, as the owner ruled (2026-11-25)', () => {
  it('Q1: the refreshed line goes once reminders are turned off here, after the record turned on elsewhere', async () => {
    optInToReminders.mockResolvedValue({ email: ADDRESS, refreshed: true });
    const view = open();
    fireEvent.click(button(view, 'Turn on reminders'));
    await waitFor(() => expect(text(view)).toContain(REFRESHED));
    recordOptIn = ACTIVE;
    changed();
    expect(text(view)).toContain(ON_LINE);
    cancelReminders.mockImplementation(async () => { recordOptIn = { ...ACTIVE, status: 'cancelled', lamport: 2 }; });
    fireEvent.click(button(view, 'Turn off'));
    await waitFor(() => expect(text(view)).toContain(OFF_LINE));
    expect(text(view)).not.toContain(REFRESHED);
    expect(button(view, 'Turn on email health reminders').disabled).toBe(false);
  });

  it('Q2: a step left open when the record turns on elsewhere closes; after Turn off it is the off line', async () => {
    const view = open();
    fireEvent.click(view.getByRole('checkbox'));
    fireEvent.change(view.getByRole('textbox'), { target: { value: 'typed@example.com' } });
    recordOptIn = ACTIVE;
    changed();
    expect(text(view)).toContain(ON_LINE);
    cancelReminders.mockImplementation(async () => { recordOptIn = { ...ACTIVE, status: 'cancelled', lamport: 2 }; });
    fireEvent.click(button(view, 'Turn off'));
    await waitFor(() => expect(text(view)).toContain(OFF_LINE));
    expect(view.queryByRole('textbox')).toBeNull();
    fireEvent.click(button(view, 'Turn on email health reminders'));
    expect((view.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
  });

  it('Q3: the record turning on while Turn on still runs shows the on line with "Setting up…", off', async () => {
    const call = deferred<{ email: string; refreshed: boolean }>();
    optInToReminders.mockReturnValue(call.promise);
    const view = open();
    fireEvent.click(button(view, 'Turn on reminders'));
    await waitFor(() => expect(button(view, 'Setting up…')).toBeTruthy());
    recordOptIn = ACTIVE;
    changed();
    expect(text(view)).toContain(ON_LINE);
    expect(button(view, 'Setting up…').disabled).toBe(true);
    expect(view.queryByRole('button', { name: 'Turning off…' })).toBeNull();
    await act(async () => { call.resolve({ email: ADDRESS, refreshed: false }); });
    expect(button(view, 'Turn off').disabled).toBe(false);
  });

  it('Q4: the form is read-only while Turn on runs; a failure keeps what was submitted', async () => {
    const call = deferred<{ email: string; refreshed: boolean }>();
    optInToReminders.mockReturnValue(call.promise);
    const view = open();
    fireEvent.click(view.getByRole('checkbox'));
    fireEvent.change(view.getByRole('textbox'), { target: { value: 'list-person@example.com' } });
    fireEvent.click(button(view, 'Turn on reminders'));
    await waitFor(() => expect(button(view, 'Setting up…')).toBeTruthy());
    const field = view.getByRole('textbox') as HTMLInputElement;
    expect(field.readOnly).toBe(true);
    fireEvent.change(field, { target: { value: 'edited@example.com' } });
    fireEvent.click(view.getByRole('checkbox'));
    expect((view.getByRole('checkbox') as HTMLInputElement).checked).toBe(true);
    await act(async () => { call.reject(new Error('Could not set up reminders (503).')); });
    expect((view.getByRole('textbox') as HTMLInputElement).value).toBe('list-person@example.com');
    expect((view.getByRole('textbox') as HTMLInputElement).readOnly).toBe(false);
    expect(text(view)).toContain('Could not set up reminders (503).');
  });
});

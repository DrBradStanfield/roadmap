// @vitest-environment jsdom
/**
 * US-22 AC13 — someone who follows an email's button back to the tool and finds
 * this browser empty is told where their plan can be, one click from the
 * storage picker. Darren (2026-09-24) made his plan in Safari, came back eight
 * days later from the reminder, and met a blank form with nothing to say why.
 *
 * The flag (`from=email`) is set by the server redirect, read before the app's
 * first await and stripped at once, so a reload or a shared link never repeats
 * the notice. Real RoadmapStore on a memory cloud decides "empty", by the same
 * test HealthTool uses to load the form.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup, act } from '@testing-library/react';
import { MemoryAdapter, MemoryCloud } from '@roadmap/health-core';
import { RoadmapStore } from '../src/storage/roadmap-store';
import { addMeasurement, initRoadmapStore } from '../src/lib/roadmap-data';
import { trackProductEvent } from '../src/lib/server-api';
import { OPEN_PICKER_EVENT } from '../src/lib/storage-notice';
import { EmailLandingNotice, emailLandingApplies, takeEmailFlag } from './email-landing';

vi.mock('../src/lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../src/lib/server-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/server-api')>()),
  trackProductEvent: vi.fn(),
}));

const arrive = (path: string, state: unknown = null) => history.replaceState(state, '', path);
const here = () => `${location.pathname}${location.search}${location.hash}`;

beforeEach(async () => {
  vi.mocked(trackProductEvent).mockClear();
  vi.spyOn(RoadmapStore.prototype, 'startLiveRefresh').mockReturnValue(() => {});
  await initRoadmapStore(new MemoryAdapter(new MemoryCloud())); // an empty record
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('takeEmailFlag (US-22 AC13)', () => {
  it('reads the flag and strips only it: other params, the hash and history.state survive', () => {
    arrive('/pages/roadmap?utm_source=email&from=email&variant=a%20b#plan', { keep: 1 });
    expect(takeEmailFlag()).toBe(true);
    expect(here()).toBe('/pages/roadmap?utm_source=email&variant=a%20b#plan');
    expect(history.state).toEqual({ keep: 1 });
  });

  it('a bare flag leaves a clean address', () => {
    arrive('/pages/roadmap?from=email');
    expect(takeEmailFlag()).toBe(true);
    expect(here()).toBe('/pages/roadmap');
  });

  it.each(['?from=Email', '?from=emails', '?from=', '?from=email%20', '?xfrom=email', ''])(
    '"%s" is not the flag: nothing shows and the address is untouched',
    (query) => {
      arrive(`/pages/roadmap${query}`);
      expect(takeEmailFlag()).toBe(false);
      expect(here()).toBe(`/pages/roadmap${query}`);
    },
  );
});

describe('emailLandingApplies (US-22 AC13)', () => {
  it('a guest arriving from an email to an empty record: shows, and is counted once', async () => {
    expect(await emailLandingApplies(true, 'guest')).toBe(true);
    expect(trackProductEvent).toHaveBeenCalledTimes(1);
    expect(trackProductEvent).toHaveBeenCalledWith('email_landing_empty');
  });

  it('a remembered cloud user with the flag sees nothing, and the flag is still stripped', async () => {
    arrive('/pages/roadmap?from=email');
    expect(takeEmailFlag()).toBe(true);
    expect(here()).toBe('/pages/roadmap');
    expect(await emailLandingApplies(true, 'cloud')).toBe(false);
    expect(trackProductEvent).not.toHaveBeenCalled();
  });

  it('a provider that could not be read (reconnect) sees nothing: its own line already names it', async () => {
    expect(await emailLandingApplies(true, 'reconnect')).toBe(false);
    expect(trackProductEvent).not.toHaveBeenCalled();
  });

  it('a guest whose browser still holds a plan sees nothing', async () => {
    await addMeasurement('ldl', 3.1, '2026-09-01');
    expect(await emailLandingApplies(true, 'guest')).toBe(false);
    expect(trackProductEvent).not.toHaveBeenCalled();
  });

  it('no flag, no notice', async () => {
    expect(await emailLandingApplies(false, 'guest')).toBe(false);
    expect(trackProductEvent).not.toHaveBeenCalled();
  });

  // main() awaits this before the widget mounts, and nothing there catches:
  // a read that fails must show no notice, never reject into an empty mount
  // (US-09 AC16; adversarial review of 950844e, 2026-09-25).
  it('a record that cannot be read shows nothing and never rejects', async () => {
    vi.spyOn(RoadmapStore.prototype, 'loadLatestMeasurements').mockImplementation(() => { throw new Error('read failed'); });
    await expect(emailLandingApplies(true, 'guest')).resolves.toBe(false);
    expect(trackProductEvent).not.toHaveBeenCalled();
  });
});

describe('EmailLandingNotice (US-22 AC13)', () => {
  it('says where the plan can be, and Connect is one click to the picker', () => {
    const opened = vi.fn();
    window.addEventListener(OPEN_PICKER_EVENT, opened);
    const { getByRole } = render(<EmailLandingNotice />);

    const text = getByRole('status').textContent ?? '';
    expect(text).toContain('Looking for your plan?');
    expect(text).toContain('If you saved it to Google Drive or Dropbox, connect it and it loads.');
    expect(text).toContain('If not, it stays only in the browser you made it in, and Safari can clear that after a week without a visit.');
    expect(text).toContain('Your PDF still has it, if you saved one.');
    expect(text).not.toMatch(/—/);
    fireEvent.click(getByRole('button', { name: 'Connect' }));
    expect(opened).toHaveBeenCalledTimes(1);
    window.removeEventListener(OPEN_PICKER_EVENT, opened);
  });

  it('can be dismissed', () => {
    const { getByRole, queryByRole } = render(<EmailLandingNotice />);
    fireEvent.click(getByRole('button', { name: 'Dismiss' }));
    expect(queryByRole('status')).toBeNull();
  });
});

/**
 * US-22 AC14 (2026-10-04) — most empty landings are the mail app's own browser,
 * a storage area that never held the plan, while clicks that opened the
 * person's own browser found it intact. So the notice first says what works:
 * open the page there. The address is a literal, never location.href (that
 * would carry whatever query the click arrived with).
 */
describe('EmailLandingNotice: the in-app line and Copy link (US-22 AC14)', () => {
  const ADDRESS = 'https://drstanfield.com/pages/roadmap';
  const SHOWN = 'drstanfield.com/pages/roadmap';
  const IN_APP =
    'Opened this from your email app? Your plan is in the browser where you made it. Open drstanfield.com/pages/roadmap there.';
  const setClipboard = (clipboard: unknown) =>
    Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true });
  afterEach(() => {
    setClipboard(undefined);
    vi.useRealTimers();
  });

  // One paragraph more than AC13, no address row: the notice must still fit an
  // iPhone 15 screen at load, Connect and Dismiss included.
  it('opens with the in-app line, whose address is the copy target, and Copy link joins the Connect row', () => {
    arrive('/pages/roadmap?utm_source=klaviyo#plan');
    const { getByRole, getByText } = render(<EmailLandingNotice />);
    const notice = getByRole('status');
    const text = notice.textContent ?? '';
    expect(text.startsWith(IN_APP)).toBe(true);
    expect(text).not.toContain('https://');
    expect(text).not.toContain(location.href);
    expect(text).not.toMatch(/—/);
    expect(getByText(IN_APP.slice(0, 32)).closest('p')?.textContent).toBe(IN_APP);
    expect(getByText(SHOWN).closest('p')?.textContent).toBe(IN_APP);
    const buttons = [...notice.querySelectorAll(':scope > button')].map((b) => b.textContent);
    expect(buttons).toEqual(['Connect', 'Copy link', 'Dismiss']);
    expect(text.indexOf('Looking for your plan?')).toBeLessThan(text.indexOf('Copy link'));
  });

  it('the copy runs inside the press, before any await (WebKit refuses a write outside the gesture)', () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });
    const { getByRole } = render(<EmailLandingNotice />);
    fireEvent.click(getByRole('button', { name: 'Copy link' }));
    expect(writeText).toHaveBeenCalledWith(ADDRESS);
  });

  it('copies the literal address, counts the copy, and says Copied briefly', async () => {
    vi.useFakeTimers();
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });
    arrive('/pages/roadmap?utm_source=klaviyo');
    const { getByRole } = render(<EmailLandingNotice />);
    await act(async () => { fireEvent.click(getByRole('button', { name: 'Copy link' })); });
    expect(writeText).toHaveBeenCalledWith(ADDRESS);
    expect(trackProductEvent).toHaveBeenCalledWith('email_landing_link_copied');
    expect(getByRole('status').contains(getByRole('button', { name: 'Copied' }))).toBe(true);
    act(() => { vi.advanceTimersByTime(2000); });
    expect(getByRole('button', { name: 'Copy link' })).toBeTruthy();
  });

  it.each([
    ['missing', () => undefined],
    ['refused', () => ({ writeText: vi.fn().mockRejectedValue(new Error('NotAllowedError')) })],
  ])('a %s clipboard selects the address in the sentence and asks for a copy by hand, uncounted', async (_case, clipboard) => {
    setClipboard(clipboard());
    const { getByRole } = render(<EmailLandingNotice />);
    await act(async () => { fireEvent.click(getByRole('button', { name: 'Copy link' })); });
    expect(window.getSelection()?.toString()).toBe(SHOWN);
    expect(getByRole('button', { name: 'Select and copy the address' })).toBeTruthy();
    expect(trackProductEvent).not.toHaveBeenCalledWith('email_landing_link_copied');
  });

  it('a stale Copied timer never overwrites a newer label', async () => {
    vi.useFakeTimers();
    const writeText = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('NotAllowedError'));
    setClipboard({ writeText });
    const { getByRole } = render(<EmailLandingNotice />);
    await act(async () => { fireEvent.click(getByRole('button', { name: 'Copy link' })); });
    act(() => { vi.advanceTimersByTime(1000); });
    await act(async () => { fireEvent.click(getByRole('button', { name: 'Copied' })); });
    act(() => { vi.advanceTimersByTime(2000); });
    expect(getByRole('button', { name: 'Select and copy the address' })).toBeTruthy();
  });

  it('dismissing clears a pending Copied timer', async () => {
    vi.useFakeTimers();
    setClipboard({ writeText: vi.fn().mockResolvedValue(undefined) });
    const { getByRole } = render(<EmailLandingNotice />);
    await act(async () => { fireEvent.click(getByRole('button', { name: 'Copy link' })); });
    expect(vi.getTimerCount()).toBe(1);
    fireEvent.click(getByRole('button', { name: 'Dismiss' }));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('Connect and Dismiss still work beside Copy link', () => {
    const opened = vi.fn();
    window.addEventListener(OPEN_PICKER_EVENT, opened);
    const { getByRole, queryByRole } = render(<EmailLandingNotice />);
    fireEvent.click(getByRole('button', { name: 'Connect' }));
    expect(opened).toHaveBeenCalledTimes(1);
    window.removeEventListener(OPEN_PICKER_EVENT, opened);
    fireEvent.click(getByRole('button', { name: 'Dismiss' }));
    expect(queryByRole('status')).toBeNull();
  });
});

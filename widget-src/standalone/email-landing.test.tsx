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
import { render, fireEvent, cleanup } from '@testing-library/react';
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
    expect(text).toContain('Your PDF still has it.');
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

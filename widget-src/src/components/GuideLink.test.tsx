// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';

const trackProductEvent = vi.hoisted(() => vi.fn());
vi.mock('../lib/server-api', () => ({ trackProductEvent }));
import { GUIDE_URL, GuideLink } from './GuideLink';

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { cleanup(); });

/** US-38 AC1 — the open-source hub link, one card at the foot of the plan. */
describe('US-38 AC1 GuideLink', () => {
  it('shows the name and the one line under it, as a new-tab link to the guide', () => {
    const { getByRole } = render(<GuideLink />);
    const link = getByRole('link');
    expect(link.querySelector('.hr-guide-card-title')?.textContent).toBe('Supercharge this tool');
    expect(link.querySelector('.hr-guide-card-line')?.textContent).toBe(
      'Open source. Use your record with ChatGPT, Claude or the command line.',
    );
    expect(link.getAttribute('href')).toBe(GUIDE_URL);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener');
  });

  it('counts a click', () => {
    const { getByRole } = render(<GuideLink />);
    fireEvent.click(getByRole('link'));
    expect(trackProductEvent).toHaveBeenCalledTimes(1);
    expect(trackProductEvent).toHaveBeenLastCalledWith('guide_opened', { placement: 'plan_footer' });
  });
});

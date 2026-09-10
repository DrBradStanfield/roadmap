// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';

const trackProductEvent = vi.hoisted(() => vi.fn());
vi.mock('../lib/server-api', () => ({ trackProductEvent }));
import { GUIDE_URL, GuideLink } from './GuideLink';

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { cleanup(); });

/** US-38 — the open-source hub link, in the column header and (on mobile) at its foot. */
describe('US-38 GuideLink', () => {
  it('renders the header button as a new-tab link to the guide', () => {
    const { getByRole } = render(<GuideLink placement="header" />);
    const link = getByRole('link', { name: 'Supercharge this tool' });
    expect(link.getAttribute('href')).toBe(GUIDE_URL);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener');
    expect(link.className).toBe('action-btn-small');
  });

  it('renders the mobile footer link with its own classes and text', () => {
    const { getByRole } = render(<GuideLink placement="footer" />);
    const link = getByRole('link', {
      name: 'Open source: use it with ChatGPT, Claude or the command line',
    });
    expect(link.getAttribute('href')).toBe(GUIDE_URL);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener');
    expect(link.className).toBe('hr-guide-mobile');
  });

  it.each(['header', 'footer'] as const)('counts a %s click with the placement that sent it', (placement) => {
    const { getByRole } = render(<GuideLink placement={placement} />);
    fireEvent.click(getByRole('link'));
    expect(trackProductEvent).toHaveBeenLastCalledWith('guide_opened', { placement });
  });
});

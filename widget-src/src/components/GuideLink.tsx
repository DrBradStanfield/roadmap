import type { GUIDE_PLACEMENTS } from '@roadmap/health-core';
import { trackProductEvent } from '../lib/server-api';

/** US-38: the open-source hub — how to reach this record from an AI assistant. */
export const GUIDE_URL = 'https://drstanfield.com/blogs/guides/ai-health-record';

const TITLE = 'Open source. Connect ChatGPT, Claude or the command line to your record.';

/**
 * The same link in two places: a small button in the "Your information" column
 * header (desktop), and a text line at the foot of that column (mobile, where
 * the header is hidden).
 */
const VARIANT = {
  header: { className: 'action-btn-small', label: 'Supercharge this tool' },
  footer: {
    className: 'hr-guide-mobile',
    label: 'Open source: use it with ChatGPT, Claude or the command line',
  },
} as const;

export function GuideLink({ placement }: { placement: (typeof GUIDE_PLACEMENTS)[number] }) {
  const variant = VARIANT[placement];
  return (
    <a
      href={GUIDE_URL}
      target="_blank"
      rel="noopener"
      className={variant.className}
      onClick={() => trackProductEvent('guide_opened', { placement })}
      title={TITLE}
    >
      {variant.label}
    </a>
  );
}

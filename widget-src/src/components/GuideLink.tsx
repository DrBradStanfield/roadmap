import { trackProductEvent } from '../lib/server-api';

/** US-38: the open-source hub — how to reach this record from an AI assistant. */
export const GUIDE_URL = 'https://drstanfield.com/blogs/guides/ai-health-record';

/** US-38 AC1: one small card at the foot of the plan, on phone and desktop. */
export function GuideLink() {
  return (
    <a
      href={GUIDE_URL}
      target="_blank"
      rel="noopener"
      className="hr-guide-card no-print"
      onClick={() => trackProductEvent('guide_opened', { placement: 'plan_footer' })}
    >
      <span className="hr-guide-card-title">Supercharge this tool</span>
      <span className="hr-guide-card-line">Open source. Use your record with ChatGPT, Claude or the command line.</span>
    </a>
  );
}

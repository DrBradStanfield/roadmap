/**
 * US-50 AC5 and AC6: the prompt clauses that make the block headers and the
 * YouTube master views mean something. Static checks only; the answer
 * fixtures are the behavioural check (owner: orchestrator).
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';

vi.mock('@sentry/react-router', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('./supabase.server', () => ({ supabaseAdmin: null }));

import { MASTER_VIEWS_HEADING } from './youtube-bot.server';

const system = readFileSync('app/lib/chat-system-prompt.md', 'utf-8');
const youtube = readFileSync('app/lib/chat-youtube-prompt.md', 'utf-8');
const section = (md: string, heading: string) => md.slice(md.indexOf(heading), md.indexOf('\n### ', md.indexOf(heading) + 1));

describe('answer prompt precedence (US-50 AC5)', () => {
  const loaded = section(system, '### On loaded reference content');

  it('sits in the loaded-reference section and keeps it supplementary', () => {
    expect(loaded).toContain('the loaded content is supplementary, not authoritative');
    expect(loaded).toContain('[reference — current view reviewed 2026-10-20]');
    expect(loaded).toContain('[video post — published 2025-03-12]');
  });

  it('ranks the current view over an older post, and this prompt and PRODUCTS over both', () => {
    expect(loaded).toMatch(/"Current view" section .* outranks any loaded post or video published before that date/);
    expect(loaded).toMatch(/This prompt .* and the PRODUCTS section still outrank both/);
    expect(loaded).toContain("say plainly that Brad's view has changed");
  });

  it('only cited Current-view sentences are Brad\'s view; a Current evidence position never is', () => {
    expect(loaded).toContain('Only sentences in a "Current view" section that cite one of Brad\'s posts may be presented as Brad\'s view');
    expect(loaded).toContain('A "Current evidence position" section is an evidence summary, never Brad\'s view');
  });

  it('keeps the collagen and nitric-oxide rules', () => {
    expect(system).toContain('- **Nitric oxide:** MicroVitamin and MicroVitamin+ are not nitric-oxide products');
    expect(system).toContain('- **Collagen and skin:** for a concern about skin ageing');
  });
});

describe('YouTube prompt and the master views (US-50 AC6)', () => {
  it('names the exact heading the bot adds', () => {
    expect(youtube).toContain(`**The "${MASTER_VIEWS_HEADING}" section never counts here.**`);
    expect(youtube).toContain(`3. **"${MASTER_VIEWS_HEADING}"**`);
  });

  it('the reply-or-skip rule ignores the section', () => {
    expect(youtube).toContain('Ignore it in Step 1 and Step 2: decide between Output A and Output B exactly as you would without it.');
  });

  it('states the two-axis rule and allows a public "view has changed"', () => {
    expect(youtube).toContain("The video's content is the authority on what the video said; this section is the authority on Brad's view today.");
    expect(youtube).toContain("a reply may say publicly that Brad's view has changed since the video");
  });
});

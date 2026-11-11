/**
 * US-15 (what chat leaves behind) and US-32 (the report_feedback guard's limits): pins the
 * privacy sentences ruled for PR 1223 round 2 (the saved-chat answer per surface: api.chat-saved-chat.test.ts, C1), so a later edit cannot quietly restore an
 * overclaim. Static checks on the prompt files, the guides and the reminders disclosure.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

const read = (p: string) => readFileSync(p, 'utf-8');
const system = read('app/lib/chat-system-prompt.md');
const doctor = read('app/lib/chat-posture-doctor.md');
const reminders = read('widget-src/standalone/reminders-control.tsx');

const GUARD =
  'It refuses a report that looks like it holds a value, an email or a phone number. It can miss one, and it cannot spot a diagnosis written in words, so read the report before you agree.';

describe('the store-account instruction stays (US-15)', () => {
  it('account questions still go to the store account page, never chat or health data', () => {
    expect(system).toContain('do NOT point users to account.microvitamin.com for chat or health data');
  });
});

describe('the doctor posture claims only the health record is in the user\'s storage (US-15)', () => {
  const identity = doctor.slice(doctor.indexOf('### Identity / account'), doctor.indexOf('\n### ', doctor.indexOf('### Identity / account') + 1));

  it('it says the health record lives in their own storage', () => {
    expect(identity).toContain("the user's health record lives in their OWN storage");
  });

  it('it no longer routes saved-conversation questions to that claim', () => {
    expect(identity).not.toMatch(/saved-conversation/i);
    expect(identity).not.toMatch(/chat (history )?(lives|is saved|is kept)/i);
  });
});

describe('the feedback guard states its limits in every guide (US-32)', () => {
  it.each([
    ['docs/guides/connect-chatgpt.md', 2],
    ['docs/guides/connect-claude-desktop.md', 1],
  ])('%s carries the ruled sentence %i time(s)', (path, count) => {
    expect(read(path).split(GUARD).length - 1).toBe(count);
    expect(read(path)).not.toContain('It refuses a report that holds a value');
  });

  it('where-your-data-lives agrees and says it can miss one', () => {
    const guide = read('docs/guides/where-your-data-lives.md');
    expect(guide).toContain('The tool refuses a report that looks like it holds a value, an email or a phone number. It can miss one,');
  });
});

describe('the guide says which chats create an account row (US-15 AC7b)', () => {
  const guide = read('docs/guides/where-your-data-lives.md');
  it('the tool page chat runs as if you were not signed in', () => {
    expect(guide).toContain("the tool page's chat still runs as if you were not");
  });
  it('the bubble and the embed are both named, and the account row is what stays', () => {
    expect(guide).toContain('Where the chat bubble or the chatbot embed appears on other pages');
    expect(guide).toContain('The daily job and Delete All My Data do not remove your account row.');
  });
  it('the names sentence does not tie updates to each read', () => {
    expect(guide).toContain('Our server updates your names from your store account from time to time.');
    expect(guide).not.toContain('Later messages keep the names up to date');
  });
});

describe('the reminders disclosure claims no more than it sends (US-17)', () => {
  it('it no longer promises that reminders send nothing else', () => {
    expect(reminders).not.toContain('nothing else');
  });

  it('it names the address on both lanes', () => {
    expect(reminders).toContain('your email address (the one on your cloud account, or the one you typed)');
  });
});

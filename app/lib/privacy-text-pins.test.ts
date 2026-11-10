/**
 * US-15 (what chat leaves behind) and US-32 (the report_feedback guard's limits): pins the
 * privacy sentences ruled for PR 1223 round 2, so a later edit cannot quietly restore an
 * overclaim. Static checks on the prompt files, the guides and the reminders disclosure.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

const read = (p: string) => readFileSync(p, 'utf-8');
const system = read('app/lib/chat-system-prompt.md');
const doctor = read('app/lib/chat-posture-doctor.md');
const reminders = read('widget-src/standalone/reminders-control.tsx');

const SAVED_CHAT_ANSWER =
  "Your health record and tool-page chats are saved in your own storage, not on our server. Our server keeps the text of each chat question for 30 days. If the question is about your health, it also keeps a copy with no end date, to improve the chatbot, after an automatic step tries to remove details that identify you. 'Where your health data lives' lists what it keeps and for how long.";

const GUARD =
  'It refuses a report that looks like it holds a value, an email or a phone number. It can miss one, and it cannot spot a diagnosis written in words, so read the report before you agree.';

describe('the saved-chat answer says what the server keeps (US-15)', () => {
  it('the system prompt scripts the ruled answer', () => {
    expect(system).toContain(`*"${SAVED_CHAT_ANSWER}"*`);
  });

  it('the old answer, which said nothing reaches the server, is gone', () => {
    expect(system).not.toContain("It's never kept in a Dr Brad account, so your health data stays yours.");
    expect(system).not.toContain('Yes — your conversations are saved to your own storage.');
  });

  it('the store-account instruction stays', () => {
    expect(system).toContain('never to a Dr Brad / MicroVitamin server account');
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

describe('the reminders disclosure claims no more than it sends (US-17)', () => {
  it('it no longer promises that reminders send nothing else', () => {
    expect(reminders).not.toContain('nothing else');
  });

  it('it names the address on both lanes', () => {
    expect(reminders).toContain('your email address (the one on your cloud account, or the one you typed)');
  });
});

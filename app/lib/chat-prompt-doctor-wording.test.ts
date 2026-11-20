/**
 * US-07 AC17 (Brad 2026-11-20): the chat words medicines as topics to discuss with a doctor, and a range
 * as where the number sits, never as a condition the user has. The agent-facing data still carries the
 * plan's grade names ("Obese (Class I)"), so these two prompt rules carry the framing.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

const lines = readFileSync('app/lib/chat-system-prompt.md', 'utf-8').split('\n');

describe('US-07 AC17: the chat prompt frames medicines and ranges', () => {
  it('medicines, dose changes and supplements are things to consider discussing, never instructions', () => {
    const rule = lines.find((l) => l.includes('When a reply mentions a medicine, a dose change or a supplement')) ?? '';
    expect(rule).toContain('Consider discussing a statin with your doctor');
    expect(rule).toContain('Never tell the user to start, stop, take, raise or switch one');
  });

  it('a number is described against the guideline\'s range, and a doctor confirms a diagnosis', () => {
    const rule = lines.find((l) => l.startsWith('- Describe where a number sits against the guideline\'s range')) ?? '';
    expect(rule).toContain('in the obesity range');
    expect(rule).toContain('Never tell the user they have or do not have a condition');
    expect(rule).toContain('a doctor confirms a diagnosis');
  });
});

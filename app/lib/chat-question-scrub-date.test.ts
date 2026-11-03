import { describe, it, expect } from 'vitest';
import { scrubQuestion } from './chat-question-scrub.server';
import type { AnthropicResult } from './anthropic.server';

// US-15 AC44d: a [date] placeholder stands only for a day and a month (or a
// d/m shape). The year is kept, as the scrub prompt says, and no other word
// rides along. Synthetic questions only.

const USAGE = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };

const answer = (scrubbed: string): AnthropicResult => ({
  content: '',
  usage: USAGE,
  stopReason: 'tool_use',
  contentBlocks: [{ type: 'tool_use', id: 'toolu_1', name: 'save_scrubbed_question', input: { scrubbed } }],
});

const scrub = (question: string, scrubbed: string) => scrubQuestion(question, { call: async () => answer(scrubbed) });

describe('scrubQuestion: US-15 AC44d a date placeholder covers only a day and a month', () => {
  it.each([
    ['the year', 'tested in March 2024, LDL 3.1, is that high?', 'tested in [date], LDL 3.1, is that high?'],
    ['a clause beside a month', 'March and cancer, what helps?', '[date], what helps?'],
    ['a word before the month', 'In May my HbA1c was high', '[date] my HbA1c was high'],
    ['a diagnosis after the day', 'since 3 March diabetic, is metformin ok?', 'since [date], is metformin ok?'],
    ['a word that starts like a month', 'my iron decreased, is that bad?', 'my iron [date], is that bad?'],
    ['a race that starts like a month', 'I ran a marathon with low ferritin', 'I ran a [date] with low ferritin'],
    ['a bare number', 'are 3 coffees a day too many?', 'are [date] coffees a day too many?'],
    ['a lab value beside the month', 'my LDL 130 March 3rd, too high?', 'my LDL [date], too high?'],
    ['two months joined by "and"', 'tested in March and April 2024', 'tested in [date] 2024'],
    ['a time beside the date', 'my testosterone at 8am March 3rd was low', 'my testosterone at [date] was low'],
    // Each word is tested on its own, whole (adversary + Codex on PR 511).
    ['a year glued to the month', 'tested March-2024, LDL 3.1', 'tested [date], LDL 3.1'],
    ['a diagnosis glued to the month', 'March/cancer, what helps?', '[date], what helps?'],
    ['a month glued after a word', 'cancer/March, what helps?', '[date], what helps?'],
    // At most one day number, so a 2-digit lab value cannot ride along.
    ['a 2-digit lab value beside the day', 'my LDL 80 March 3rd, too high?', 'my LDL [date], too high?'],
    ['two bare numbers and a month', 'my LDL 80 3 March, too high?', 'my LDL [date], too high?'],
    // A day is 1 to 31, and lower-case "may" is the verb (Codex and adversary re-check on PR 660).
    ['a lab value no day can be', 'my LDL 80 March, too high?', 'my LDL [date], too high?'],
    ['a lab value beside the verb may', 'A ferritin of 15 may mean low iron?', 'A ferritin [date] mean low iron?'],
    ['the verb may alone', 'My statin may cause pain', 'My statin [date] cause pain'],
  ])('skips %s', async (_, q, a) => {
    expect(await scrub(q, a)).toBeNull();
  });

  it.each([
    ['a month', 'tested in May 2024, LDL 3.1', 'tested in [date] 2024, LDL 3.1'],
    ['a day and a month', 'tested on 3 March 2024, LDL 3.1', 'tested on [date] 2024, LDL 3.1'],
    ['a month and an ordinal day', 'tested on March 3rd, 2024', 'tested on [date], 2024'],
    ['"3rd of March"', 'tested on the 3rd of March 2024', 'tested on the [date] 2024'],
    ['a d/m shape', 'tested 3/4 this year, LDL 3.1', 'tested [date] this year, LDL 3.1'],
    ['a masked widget day', 'tested on ## March ####, LDL #.#', 'tested on [date] ####, LDL #.#'],
    ['an upper-case month', 'tested on 3 MARCH 2024', 'tested on [date] 2024'],
    ['a day and May', 'tested on 15 May 2024, LDL 3.1', 'tested on [date] 2024, LDL 3.1'],
    ['short month names', 'tested 3 Sept and 4 Dec 2024', 'tested [date] and [date] 2024'],
  ])('keeps %s', async (_, q, a) => {
    expect(await scrub(q, a)).toBe(a);
  });
});

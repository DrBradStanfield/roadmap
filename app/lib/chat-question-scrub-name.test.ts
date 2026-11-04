import { describe, it, expect } from 'vitest';
import { scrubQuestion } from './chat-question-scrub.server';
import type { AnthropicResult } from './anthropic.server';

// US-15 AC44c: a [name], [place] or [job] placeholder stands only for words
// that each start with a capital letter (a few lower-case joining words such
// as "of", "de" and "van" aside), so it cannot swallow the lower-case words
// of a clause beside a name. Synthetic questions only.

const USAGE = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };

const answer = (scrubbed: string): AnthropicResult => ({
  content: '',
  usage: USAGE,
  stopReason: 'tool_use',
  contentBlocks: [{ type: 'tool_use', id: 'toolu_1', name: 'save_scrubbed_question', input: { scrubbed } }],
});

const scrub = (question: string, scrubbed: string) => scrubQuestion(question, { call: async () => answer(scrubbed) });

describe('scrubQuestion: US-15 AC44c a name, place or job placeholder covers only capitalised words', () => {
  it.each([
    ['a diagnosis beside a name', 'Alice has cancer today, what diet helps?', '[name] today, what diet helps?'],
    ['a symptom beside a place', 'Auckland gives me headaches, is it the pollen?', '[place], is it the pollen?'],
    ['a drug beside a job', 'Fonterra pays for metformin, is it safe?', '[job], is it safe?'],
    ['lower-case words after a name', 'Dr Lee prescribed statins for my LDL', '[name] for my LDL'],
    ['a lower-case word inside a name span', 'my GP Jane took bloods Smith said fine', 'my GP [name] said fine'],
    ['joining words alone', 'I am tired of the statins', 'I am tired [name] statins'],
    ['a capitalised word holding a digit', 'is B12 safe with metformin?', 'is [name] safe with metformin?'],
    ['a word with a capital inside it', 'my GP Jane eGFR is 55, is that ok?', 'my GP [name] is 55, is that ok?'],
  ])('skips %s', async (_, q, a) => {
    expect(await scrub(q, a)).toBeNull();
  });

  it.each([
    ['one name', 'Dr Lee says my ApoB is 1.1', '[name] says my ApoB is 1.1'],
    ['a titled name', 'Dr. Lee said my ferritin of 12 is low', '[name] said my ferritin of 12 is low'],
    ['a full name', 'My doctor Jane Smith says my LDL is high', 'My doctor [name] says my LDL is high'],
    ['a name with an apostrophe and a hyphen', "Mary O'Brien-Jones says I need iron", '[name] says I need iron'],
    ['a name with "van"', 'Dr Pieter van Dijk wants an HbA1c test', '[name] wants an HbA1c test'],
    ['a place with a comma', 'I live in Ponsonby, Auckland and my TSH is 4.1', 'I live in [place] and my TSH is 4.1'],
    ['a hospital', "St Mary's Hospital said my eGFR is 55", '[place] said my eGFR is 55'],
    ['an employer with "of"', 'I work at the University of Otago, is shift work bad?', 'I work at the [job], is shift work bad?'],
    ['a name typed in capitals', 'ask DR LEE about my BP', 'ask [name] about my BP'],
    ['a place with "de"', 'I moved to Rio de Janeiro and my TSH is 4.1', 'I moved to [place] and my TSH is 4.1'],
  ])('keeps %s', async (_, q, a) => {
    expect(await scrub(q, a)).toBe(a);
  });
});

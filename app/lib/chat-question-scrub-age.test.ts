import { describe, it, expect } from 'vitest';
import { scrubQuestion } from './chat-question-scrub.server';
import type { AnthropicResult } from './anthropic.server';

// US-15 AC44b: an age placeholder keeps the copy only when it names the age's
// own decade (90 and over as [age 90+]). Synthetic questions only.

const USAGE = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };

const answer = (scrubbed: string): AnthropicResult => ({
  content: '',
  usage: USAGE,
  stopReason: 'tool_use',
  contentBlocks: [{ type: 'tool_use', id: 'toolu_1', name: 'save_scrubbed_question', input: { scrubbed } }],
});

const scrub = (question: string, scrubbed: string) => scrubQuestion(question, { call: async () => answer(scrubbed) });

describe('scrubQuestion: US-15 AC44b an age placeholder names its own decade', () => {
  it.each([
    ['47 as the 80s', "I'm 47 and tired, is my ferritin low?", "I'm [age 80s] and tired, is my ferritin low?"],
    ['47 as 90+', "I'm 47 and tired, is my ferritin low?", "I'm [age 90+] and tired, is my ferritin low?"],
    ['82 as the 70s', 'my 82 year old mother takes amlodipine', 'my [age 70s] year old mother takes amlodipine'],
    ['93 as the 90s, not 90+', 'My dad is 93, should he take a statin?', 'My dad is [age 90s], should he take a statin?'],
    ['93 as the 80s', 'My dad is 93, should he take a statin?', 'My dad is [age 80s], should he take a statin?'],
    ['89 as 90+', 'My dad is 89, should he take a statin?', 'My dad is [age 90+], should he take a statin?'],
    ['50 as the 40s', "I'm 50 and my BP is high", "I'm [age 40s] and my BP is high"],
    ['39 as the 40s', "I'm 39 and my BP is high", "I'm [age 40s] and my BP is high"],
    ['a 4-digit number as 90+', 'my PIN is 1234, is my B12 low?', 'my PIN is [age 90+], is my B12 low?'],
  ])('skips %s', async (_, q, a) => {
    expect(await scrub(q, a)).toBeNull();
  });

  it.each([
    ['47 as the 40s', "I'm 47 and tired, is my ferritin low?", "I'm [age 40s] and tired, is my ferritin low?"],
    ['40 as the 40s', "I'm 40 and my BP is high", "I'm [age 40s] and my BP is high"],
    ['49 as the 40s', "I'm 49 and my BP is high", "I'm [age 40s] and my BP is high"],
    ['82 as the 80s', 'my 82 year old mother takes amlodipine', 'my [age 80s] year old mother takes amlodipine'],
    ['90 as 90+', 'My dad is 90, should he take a statin?', 'My dad is [age 90+], should he take a statin?'],
    ['93 as 90+', 'My dad is 93, should he take a statin?', 'My dad is [age 90+], should he take a statin?'],
    ['101 as 90+', 'My gran is 101, is vitamin D safe?', 'My gran is [age 90+], is vitamin D safe?'],
    ['upper case placeholder', "I'm 47 and tired", "I'm [AGE 40s] and tired"],
    // The widget masks every digit before the row is stored, so a masked age has no decade to check (as before).
    ['a masked widget age', "I'm ## and my HbA1c is ##", "I'm [age 40s] and my HbA1c is ##"],
  ])('keeps %s', async (_, q, a) => {
    expect(await scrub(q, a)).toBe(a);
  });
});

import { describe, it, expect } from 'vitest';
import { scrubQuestion } from './chat-question-scrub.server';
import type { AnthropicResult } from './anthropic.server';

// US-15 AC44e (GHSA-8hq4-99jq-vfp8): the model can leave a social handle or a
// self-introduced name in its answer. The code pass cannot replace a name, so
// a kept copy that still shows either is skipped, never stored.

const answer = (scrubbed: string): AnthropicResult => ({
  content: '',
  usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
  stopReason: 'tool_use',
  contentBlocks: [{ type: 'tool_use', id: 'toolu_1', name: 'save_scrubbed_question', input: { scrubbed } }],
});
const scrub = (question: string, scrubbed: string) => scrubQuestion(question, { call: async () => answer(scrubbed) });

const QUESTION = 'My name is Alice Smith, find me at @alice_s. Is ferritin low?';

describe('scrubQuestion: US-15 AC44e a handle or a self-introduced name left in is a skip', () => {
  it('skips a question the model returned unchanged with a name and a handle', async () => {
    expect(await scrub(QUESTION, QUESTION)).toBeNull();
  });

  it('skips an answer that replaced the name but kept the handle', async () => {
    expect(await scrub(QUESTION, 'My name is [name], find me at @alice_s. Is ferritin low?')).toBeNull();
  });

  it('skips an answer that kept a self-introduced name ("call me")', async () => {
    const q = 'Call me Bob. Is my ferritin of 20 low?';
    expect(await scrub(q, q)).toBeNull();
  });

  it('skips a one-letter handle, and a name typed with odd spacing or in capitals', async () => {
    const one = 'Find me at @a. Is ferritin low?';
    expect(await scrub(one, one)).toBeNull();
    for (const q of ['My  name is Alice Smith. Is ferritin low?', 'MY NAME IS Alice Smith. Is ferritin low?']) {
      expect(await scrub(q, q)).toBeNull();
    }
  });

  it('skips a name the model lower-cased, since the question shows it was a name', async () => {
    expect(await scrub('My name is Alice. Is ferritin low?', 'my name is alice. is ferritin low?')).toBeNull();
  });

  it("skips an accented handle, \"my name's\", and a name after a colon or a quote", async () => {
    for (const q of ['IG @élodie, is ferritin low?', "My name's Alice, is ferritin low?", 'My name is: Alice. Is ferritin low?', 'Call me "Bob". Is ferritin low?']) {
      expect(await scrub(q, q)).toBeNull();
    }
  });

  it('skips a kept name even when a later "call me" phone became [contact] (Codex R1, round 2)', async () => {
    const q = 'My name is Alice Smith. Call me 021 123 4567 about my ferritin.';
    expect(await scrub(q, q)).toBeNull();
  });

  it('skips when an intro the model lower-cased pairs with a name it kept', async () => {
    expect(await scrub('Call me alice. My name is Bob. Is ferritin low?', 'Call me [name]. My name is Bob. Is ferritin low?')).toBeNull();
  });

  it('control: the same question with both replaced is kept', async () => {
    expect(await scrub(QUESTION, 'My name is [name], find me at [contact]. Is ferritin low?'))
      .toBe('My name is [name], find me at [contact]. Is ferritin low?');
  });

  it('control: an "@" before a dose or a space is no handle, and lower-case words after "my name" stay', async () => {
    const q = 'I take B12 @ 1000 mcg and D3 @5000IU, is my name on the label important?';
    expect(await scrub(q, q)).toBe(q);
  });
});

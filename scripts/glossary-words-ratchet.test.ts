// US-64 AC44: a word docs/glossary.md retires does not come back. This runs the check `node scripts/glossary-words.mjs`
// makes, over the files git tracks, so CI's test shards run it on every push. glossary-words.test.ts tests the scanner.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BASELINE_PATH, compare, countAll } from './glossary-words.mjs';

const problems: string[] = compare(JSON.parse(readFileSync(BASELINE_PATH, 'utf8')), countAll());

describe('glossary retired-word ratchet (US-64 AC44)', () => {
  it('each tracked file uses each retired word as often as glossary-words-baseline.json records, no more and no less', () => {
    const help =
      'Use the word docs/glossary.md gives instead. After a fix, lower the record: node scripts/glossary-words.mjs --write ' +
      '(it never raises a count; a use the entry keeps on purpose goes in that rule\'s `keep` list in scripts/glossary-words.mjs).';
    expect(problems, [...problems, help].join('\n')).toEqual([]);
  });
});

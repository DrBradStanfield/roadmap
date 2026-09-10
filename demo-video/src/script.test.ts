import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';
import vo from './vo.json';
import voConnect from './vo-connect.json';
import {CONNECT_CAPTIONS} from './timing';

/**
 * The script lives in three places: the storyboard table Brad reads, vo-connect.json
 * (the narration the voice-over is recorded from, and the beat clock) and the burned-in
 * captions. vo-connect.json is the source of truth; drift between the three is silent,
 * so these tests fail on it.
 */

const here = dirname(fileURLToPath(import.meta.url));
const md = readFileSync(join(here, '..', 'STORYBOARDS.md'), 'utf8');

/** Narration cells carry markdown emphasis and are sometimes wrapped in quotes. */
const clean = (cell: string) =>
  cell
    .replace(/\*\*/g, '')
    .replace(/\\\|/g, '|')
    .replace(/[“”]/g, '"')
    .trim()
    .replace(/^"(.*)"$/s, '$1')
    .replace(/\s+/g, ' ')
    .trim();

/** The rows of the "Video A" table: beat number and its narration cell. */
const videoARows = (): {beat: number; narration: string}[] => {
  const section = md.split(/^## /m).find((s) => s.startsWith('Video A'));
  if (!section) throw new Error('Video A section missing from STORYBOARDS.md');
  return section
    .split('\n')
    .filter((l) => /^\|\s*\d+\s*\(/.test(l))
    .map((l) => {
      const cols = l.split(/(?<!\\)\|/).slice(1, -1);
      return {beat: Number(cols[0].trim().match(/^\d+/)![0]), narration: clean(cols[2])};
    });
};

describe('Video A script', () => {
  const rows = videoARows();

  it('has one storyboard row per narrated beat', () => {
    expect(rows.map((r) => r.beat)).toEqual(voConnect.filter((b) => b.text).map((b) => b.beat));
  });

  it.each(rows)('beat $beat storyboard narration matches vo-connect.json', ({beat, narration}) => {
    // "Unchanged" rows point at the original explainer's narration for the same beat.
    const expected = narration === 'Unchanged' ? vo[beat].text : narration;
    expect(voConnect[beat].text).toBe(expected);
  });

  it.each(voConnect.filter((b) => b.text))('beat $beat captions read as the narration', ({beat, text}) => {
    const spoken = CONNECT_CAPTIONS.filter((c) => c.beat === beat)
      .map((c) => c.lines.join(' '))
      .join(' ');
    expect(spoken).toBe(text);
  });
});

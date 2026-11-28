/**
 * US-50 AC13a: the web chat's reduced master carries the safety sections the
 * connector's get_article keeps after a cut (US-41 AC8), from one rule, at any
 * heading level from `##`. Run over the real served masters on disk (the suite
 * runs from the repo root), so a new master or a new sub-heading is checked too.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { isMaster, loadBlogIndex } from './blog-index.server';
import { stripFrontmatter } from './frontmatter';
import { cutEntry, isServed } from './mcp-knowledge.server';
import { safetyBlocks } from './master-safety';
import { MAX_VIEW_CHARS, reducedDrops, reducedMaster, safetySections } from './youtube-context';

const demote = (s: string) => s.replace(/^(#+) /gm, '#$1 ');
const count = (text: string, part: string) => text.split(part).length - 1;
const KEY_POINTS = /^## Key safety points[ \t]*$/;
const masters = loadBlogIndex().filter((e) => isMaster(e) && isServed(e)).map((e) => e.handle);

describe('the chat carries the connector\'s safety sections (US-50 AC13a)', () => {
  it('every served master: each connector safety block is in both reduced forms, once', () => {
    expect(masters.length).toBeGreaterThanOrEqual(100);
    const missing: string[] = [];
    for (const handle of masters) {
      const raw = readFileSync(`docs/blog/${handle}.md`, 'utf8');
      const pointsDropped = reducedDrops(raw).some((d) => d.startsWith('key safety points'));
      const blocks = safetyBlocks(stripFrontmatter(raw).trim()).filter((b) => !(pointsDropped && KEY_POINTS.test(b.split('\n')[0])));
      for (const form of [reducedMaster(raw, true) ?? '', reducedMaster(raw) ?? '']) {
        for (const b of blocks) if (count(form, demote(b)) !== 1) missing.push(`${handle}: ${b.split('\n')[0]} (${count(form, demote(b))})`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('every served master: the YouTube safety sections are the connector\'s blocks, key safety points aside', () => {
    const differ: string[] = [];
    for (const handle of masters) {
      const raw = readFileSync(`docs/blog/${handle}.md`, 'utf8');
      const connector = safetyBlocks(stripFrontmatter(raw).trim()).filter((b) => !KEY_POINTS.test(b.split('\n')[0])).map((b) => `#${b.split('\n')[0]}`);
      const chat = safetySections(raw).map((s) => s.split('\n')[0]);
      if ([...chat].sort().join('|') !== [...connector].sort().join('|')) differ.push(handle);
    }
    expect(differ).toEqual([]);
  });

  const MASTER = [
    '## Current view', 'View.', '## Key safety points', '- One [1].', '- Two.', '- Three.',
    '## 3. Evidence for Benefits', 'Benefit.', '### Pregnancy and Lactation', 'Pregnancy text [2].', '### Bone', 'Bone text.',
    '## 4. Recommended Dosing', 'Dose.', '### Upper Safety Limits', 'Limit text.',
    '## 5. Who should not take it', 'Not for some.',
    '## 9. References', '[1] Ref one.', '[2] Ref two.',
  ].join('\n\n');

  it('a `###` safety sub-section under a non-safety section goes in, with its cited reference line, and not its sibling', () => {
    for (const form of [reducedMaster(MASTER, true)!, reducedMaster(MASTER)!]) {
      expect(form).toContain('#### Pregnancy and Lactation\n\nPregnancy text [2].');
      expect(form).toContain('[2] Ref two.');
      expect(form).not.toContain('Bone text.');
    }
    expect(safetySections(MASTER).map((s) => s.split('\n')[0])).toEqual(['#### Pregnancy and Lactation', '#### Upper Safety Limits', '### 5. Who should not take it']);
  });

  it('a safety sub-section inside the dosing section goes in once, with or without that section', () => {
    expect(count(reducedMaster(MASTER, true)!, '#### Upper Safety Limits')).toBe(1);
    expect(reducedMaster(MASTER, true)).toContain('### 4. Recommended Dosing');
    expect(count(reducedMaster(MASTER)!, '#### Upper Safety Limits')).toBe(1);
    expect(reducedMaster(MASTER)).not.toContain('Recommended Dosing');
  });

  it('a safety sub-section inside the current view goes in once, and on its own when the view is dropped as malformed', () => {
    const withNote = MASTER.replace('View.', 'View.\n\n### A Safety Note\n\nNote text.');
    expect(count(reducedMaster(withNote)!, 'Note text.')).toBe(1);
    const longView = withNote.replace('View.', 'v'.repeat(MAX_VIEW_CHARS));
    expect(reducedMaster(longView)).not.toContain('v'.repeat(100));
    expect(count(reducedMaster(longView)!, '#### A Safety Note\n\nNote text.')).toBe(1);
    // AC13's bound: a view of exactly MAX_VIEW_CHARS is dropped too.
    const head = '## Current view\n\n';
    expect(reducedMaster(`${head}${'w'.repeat(MAX_VIEW_CHARS - head.length)}\n\n## 5. Safety\n\ns`)).toBe('### 5. Safety\n\ns');
  });

  it('a "who should not" heading is a safety heading for both readers, on the first line too, at levels `##` to `######`', () => {
    expect(safetyBlocks(MASTER)).toContain('## 5. Who should not take it\n\nNot for some.');
    expect(safetyBlocks('## Who should not take it\nx')).toEqual(['## Who should not take it\nx']);
    // Levels `##` to `######`, no deeper.
    expect(safetyBlocks('## A\nx\n###### Warnings\nw\n####### Safety\ns\n## B\nb')).toEqual(['###### Warnings\nw\n####### Safety\ns']);
    expect(reducedMaster(MASTER)).toContain('### 5. Who should not take it');
  });

  it('the connector\'s cut reads the same rule: a "who should not" section past the cut follows it, and so do malformed key safety points', () => {
    const body = `## Intro\n${'a'.repeat(9_000)}\n## Key safety points\n- Only one.\n## 5. Who should not take it\nNot for some.\n## End\nz`;
    const cut = cutEntry(body, 5_000);
    expect(cut.indexOf('## 5. Who should not take it\nNot for some.')).toBeGreaterThan(4_000);
    expect(cut).toContain('## Key safety points\n- Only one.');
    expect(cut).not.toContain('## End');
    expect(reducedMaster(body)).not.toContain('Key safety points');
  });
});

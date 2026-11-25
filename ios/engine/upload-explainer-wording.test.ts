// US-12 AC32, US-52 AC13b: the web's upload explainer draws the iPhone's picture, so its labels and
// result names are the shared ones. Read from the Swift source, as lab-consent-wording.test.ts reads
// AIConsent.swift; the iPhone's sentence differs on purpose (a phone points at a folder), so only the
// drawing's words are pinned.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { UPLOAD_EXPLAINER_TEXT } from '../../packages/health-core/src/upload-text';

const swift = readFileSync(join(__dirname, '../HealthRoadmap/LabUpload/LabUploadExplainer.swift'), 'utf8');
const css = readFileSync(join(__dirname, '../../widget-src/src/components/UploadExplainer.css'), 'utf8');
const swiftResults = /static let results = \[([^\]]*)\]/.exec(swift)?.[1].match(/"([^"]*)"/g)?.map(s => s.slice(1, -1)) ?? [];
const swiftTitles = [...swift.matchAll(/title: "([^"]*)"/g)].map(m => m[1]);

describe('US-12 AC32: the web explainer draws the iPhone explainer', () => {
  it('names the same three results, in the same order', () => {
    expect(swiftResults).toEqual([...UPLOAD_EXPLAINER_TEXT.results]);
  });

  it('labels the same two pages', () => {
    expect(swiftTitles).toEqual([UPLOAD_EXPLAINER_TEXT.letter, UPLOAD_EXPLAINER_TEXT.labReport]);
  });

  it('labels the same record card', () => {
    expect(swift).toContain(`Text("${UPLOAD_EXPLAINER_TEXT.record}")`);
  });

  it('runs the same loop and the same still frame', () => {
    expect(swift).toContain('private static let loop = 6.0');
    expect(swift).toContain('reduceMotion ? 0.62');
  });

  it('flies each result at the times the web copies: from 0.3, then +0.15 per chip, for 0.25 of the loop', () => {
    const [, start, step] = /start: ([\d.]+) \+ Double\(index\) \* ([\d.]+)/.exec(swift) ?? [];
    const flight = /\(t - start\) \/ ([\d.]+)/.exec(swift)?.[1];
    expect([start, step, flight]).toEqual(['0.3', '0.15', '0.25']);
    // The web: one set of keyframes over 30%..55%, delayed 0.9 s (0.15 of 6 s) per chip; ticks land at 55, 70, 85%.
    expect(css).toMatch(/upload-explainer-fly \{\s*0%, 30% [^}]*\}\s*55%, 100%/);
    expect([...css.matchAll(/--upload-explainer-delay: ([\d.]+)s/g)].map(m => m[1])).toEqual(['0', '0.9', '1.8']);
    expect([0, 1, 2].map(i => css.includes(`upload-explainer-tick-${i} { 0%, ${55 + 15 * i - 1}.99% { opacity: 0; } ${55 + 15 * i}%`))).toEqual([true, true, true]);
  });
});

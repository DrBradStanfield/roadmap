// US-12 AC32, US-52 AC13b: the web's upload explainer draws the iPhone's picture, so its labels and
// result names are the shared ones. Read from the Swift source, as lab-consent-wording.test.ts reads
// AIConsent.swift; the iPhone's sentence differs on purpose (a phone points at a folder), so only the
// drawing's words are pinned.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { UPLOAD_EXPLAINER_TEXT } from '../../packages/health-core/src/upload-text';

const swift = readFileSync(join(__dirname, '../HealthRoadmap/LabUpload/LabUploadExplainer.swift'), 'utf8');
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
});

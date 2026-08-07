/**
 * US-12: UploadModal pipeline untested — pure-logic extraction tests.
 *
 * Direct coverage for lab-extraction.ts itself. Some of these functions
 * (resolveUnit, resolveLabValues, parseUnifiedResult, stripCodeFences,
 * extractJsonObject) are already exercised indirectly through
 * app/lib/anthropic.server.test.ts (which imports them via re-export) —
 * this file adds the pieces that had NO coverage anywhere: pagesToContentBlocks,
 * toUnifiedResult, and the numeric-range unit-resolution fallback (as opposed
 * to the alias/label lookup path, which the server test already covers).
 */
import { describe, it, expect } from 'vitest';
import {
  resolveUnit,
  parseUnifiedResult,
  toUnifiedResult,
  pagesToContentBlocks,
  VALID_METRICS,
  DOCUMENT_CLASSIFICATIONS,
  type PageContent,
} from './lab-extraction';

describe('US-12: pagesToContentBlocks', () => {
  it('converts a text page to a text content block', () => {
    const pages: PageContent[] = [{ type: 'text', content: 'hello world' }];
    expect(pagesToContentBlocks(pages)).toEqual([{ type: 'text', text: 'hello world' }]);
  });

  it('converts an image page to a base64 image content block', () => {
    const pages: PageContent[] = [{ type: 'image', content: 'QUJD', mimeType: 'image/png' }];
    expect(pagesToContentBlocks(pages)).toEqual([{
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'QUJD' },
    }]);
  });

  it('defaults image mimeType to image/jpeg when omitted', () => {
    const pages: PageContent[] = [{ type: 'image', content: 'QUJD' }];
    const [block] = pagesToContentBlocks(pages) as Array<{ source: { media_type: string } }>;
    expect(block.source.media_type).toBe('image/jpeg');
  });

  it('preserves order across a mixed text/image sequence', () => {
    const pages: PageContent[] = [
      { type: 'text', content: 'page 1' },
      { type: 'image', content: 'aaaa', mimeType: 'image/jpeg' },
      { type: 'text', content: 'page 3' },
    ];
    const blocks = pagesToContentBlocks(pages);
    expect(blocks.map(b => b.type)).toEqual(['text', 'image', 'text']);
  });

  it('handles an empty page array', () => {
    expect(pagesToContentBlocks([])).toEqual([]);
  });
});

describe('US-12: resolveUnit — numeric-range fallback (unrecognized unit string)', () => {
  // creatinine: SI validationRange 10-2650 µmol/L, conventional 0.1-30 mg/dL.
  // CREATININE_FACTOR = 88.4 (µmol/L per mg/dL).

  it('falls back to conventional when the value only fits the conventional range', () => {
    const result = resolveUnit('creatinine', 'some_weird_unit', 5);
    expect(result.confident).toBe(false);
    expect(result.system).toBe('conventional');
    expect(result.valueSI).toBeCloseTo(5 * 88.4, 1);
  });

  it('falls back to SI when the value only fits the SI range', () => {
    const result = resolveUnit('creatinine', 'some_weird_unit', 500);
    expect(result.confident).toBe(false);
    expect(result.system).toBe('si');
    expect(result.valueSI).toBe(500);
  });

  it('assumes SI (low confidence) when the value fits both ranges', () => {
    const result = resolveUnit('creatinine', 'some_weird_unit', 20);
    expect(result.confident).toBe(false);
    expect(result.system).toBe('si');
    expect(result.valueSI).toBe(20);
  });

  it('assumes SI (low confidence) when the value fits neither range', () => {
    const result = resolveUnit('creatinine', 'some_weird_unit', 999_999);
    expect(result.confident).toBe(false);
    expect(result.system).toBe('si');
    expect(result.valueSI).toBe(999_999);
  });
});

describe('US-12: toUnifiedResult', () => {
  it('builds lab values + additionalValues for classification lab_report', () => {
    const parsed = parseUnifiedResult({
      classification: 'lab_report',
      reportDate: '2026-01-15',
      values: [{ metric: 'ldl', value: 2.8, unit: 'mmol/L', confidence: 'high' as const }],
      additionalValues: [{ name: 'sodium', value: 141, unit: 'mmol/L' }],
      document: null,
    });
    const result = toUnifiedResult(parsed);
    expect(result.classification).toBe('lab_report');
    expect(result.reportDate).toBe('2026-01-15');
    expect(result.values).toHaveLength(1);
    expect(result.values[0]).toMatchObject({ metric: 'ldl', valueSI: 2.8 });
    expect(result.additionalValues).toHaveLength(1);
    expect(result.document).toBeNull();
  });

  it('drops additionalValues with an empty name even for lab_report', () => {
    const parsed = parseUnifiedResult({
      classification: 'lab_report',
      reportDate: null,
      values: [],
      additionalValues: [{ name: '', value: 141, unit: 'mmol/L' }],
      document: null,
    });
    expect(toUnifiedResult(parsed).additionalValues).toHaveLength(0);
  });

  it('builds a document result for a non-lab classification, ignoring values/additionalValues', () => {
    const parsed = parseUnifiedResult({
      classification: 'scan_result',
      reportDate: null,
      // A misbehaving LLM response could still populate these — toUnifiedResult
      // must ignore them for non-lab classifications rather than surfacing stray data.
      values: [{ metric: 'ldl', value: 2.8, unit: 'mmol/L', confidence: 'high' as const }],
      additionalValues: [{ name: 'sodium', value: 141, unit: 'mmol/L' }],
      document: {
        title: 'Colonoscopy Report',
        documentDate: '2025-11-15',
        contentMarkdown: '## Colonoscopy Report',
        metadata: { scanType: 'colonoscopy' },
      },
    });
    const result = toUnifiedResult(parsed);
    expect(result.classification).toBe('scan_result');
    expect(result.values).toEqual([]);
    expect(result.additionalValues).toEqual([]);
    expect(result.document).toMatchObject({
      classification: 'scan_result',
      title: 'Colonoscopy Report',
      documentDate: '2025-11-15',
      contentMarkdown: '## Colonoscopy Report',
      metadata: { scanType: 'colonoscopy' },
    });
  });

  it('passes through unrecognized', () => {
    const parsed = parseUnifiedResult({
      classification: 'lab_report',
      reportDate: null,
      values: [],
      additionalValues: [],
      unrecognized: ['vitamin D: 45 ng/mL'],
      document: null,
    });
    expect(toUnifiedResult(parsed).unrecognized).toEqual(['vitamin D: 45 ng/mL']);
  });
});

describe('US-12: sanity — exported constant lists', () => {
  it('VALID_METRICS lists the 11 core metrics', () => {
    expect(VALID_METRICS).toHaveLength(11);
    expect(VALID_METRICS).toContain('ldl');
    expect(VALID_METRICS).toContain('lpa');
  });

  it('DOCUMENT_CLASSIFICATIONS includes lab_report plus the document types', () => {
    expect(DOCUMENT_CLASSIFICATIONS).toContain('lab_report');
    expect(DOCUMENT_CLASSIFICATIONS).toContain('scan_result');
  });
});

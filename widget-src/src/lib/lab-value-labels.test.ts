import { describe, it, expect } from 'vitest';
import { labValueLabel, LAB_VALUE_LABELS } from './lab-value-labels';

describe('labValueLabel', () => {
  it('returns known label for sodium', () => {
    expect(labValueLabel('sodium')).toBe('Sodium');
  });

  it('returns known label for free_t4', () => {
    expect(labValueLabel('free_t4')).toBe('Free T4');
  });

  it('returns known label for hs_crp', () => {
    expect(labValueLabel('hs_crp')).toBe('hs-CRP');
  });

  it('returns known label for igf1', () => {
    expect(labValueLabel('igf1')).toBe('IGF-1');
  });

  it('returns known label for dhea_s', () => {
    expect(labValueLabel('dhea_s')).toBe('DHEA-S');
  });

  it('title-cases unknown snake_case metric', () => {
    expect(labValueLabel('gamma_gt')).toBe('Gamma Gt');
  });

  it('title-cases single word metric', () => {
    expect(labValueLabel('cortisol')).toBe('Cortisol');
  });

  it('handles multi-underscore names', () => {
    expect(labValueLabel('mean_corpuscular_volume')).toBe('Mean Corpuscular Volume');
  });

  it('has labels for all FBC metrics', () => {
    const fbc = ['haemoglobin', 'rbc', 'wbc', 'platelets', 'mcv', 'mch', 'haematocrit', 'neutrophils', 'lymphocytes', 'monocytes', 'eosinophils', 'basophils'];
    for (const m of fbc) {
      expect(LAB_VALUE_LABELS[m]).toBeDefined();
    }
  });

  it('has labels for all LFT metrics', () => {
    const lfts = ['alt', 'ast', 'ggt', 'alp', 'bilirubin', 'albumin', 'total_protein', 'globulin'];
    for (const m of lfts) {
      expect(LAB_VALUE_LABELS[m]).toBeDefined();
    }
  });

  it('has labels for all hormone metrics', () => {
    const hormones = ['testosterone', 'free_testosterone', 'shbg', 'estradiol', 'prolactin', 'progesterone', 'dhea_s', 'igf1'];
    for (const m of hormones) {
      expect(LAB_VALUE_LABELS[m]).toBeDefined();
    }
  });
});

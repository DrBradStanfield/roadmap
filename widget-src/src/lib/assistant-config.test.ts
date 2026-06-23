import { describe, it, expect, beforeEach } from 'vitest';
import {
  resolveAssistantName,
  getAssistantName,
  setAssistantName,
  DEFAULT_ASSISTANT_NAME,
} from './assistant-config';

// `resolveAssistantName` only touches `root.dataset.assistantName`, so a minimal
// stub stands in for a real element — no DOM environment needed.
function fakeRoot(assistantName?: string): HTMLElement {
  return { dataset: assistantName === undefined ? {} : { assistantName } } as unknown as HTMLElement;
}

describe('resolveAssistantName', () => {
  it('returns the data attribute value when present', () => {
    expect(resolveAssistantName(fakeRoot('MicroVitamin'))).toBe('MicroVitamin');
  });

  it('defaults to "Brad AI" when the attribute is absent', () => {
    expect(resolveAssistantName(fakeRoot())).toBe(DEFAULT_ASSISTANT_NAME);
    expect(DEFAULT_ASSISTANT_NAME).toBe('Brad AI');
  });

  it('defaults to "Brad AI" when the attribute is blank/whitespace', () => {
    expect(resolveAssistantName(fakeRoot('   '))).toBe(DEFAULT_ASSISTANT_NAME);
    expect(resolveAssistantName(fakeRoot(''))).toBe(DEFAULT_ASSISTANT_NAME);
  });

  it('trims surrounding whitespace from a real value', () => {
    expect(resolveAssistantName(fakeRoot('  MicroVitamin  '))).toBe('MicroVitamin');
  });

  it('defaults when the root element is null', () => {
    expect(resolveAssistantName(null)).toBe(DEFAULT_ASSISTANT_NAME);
  });
});

describe('getAssistantName / setAssistantName', () => {
  beforeEach(() => setAssistantName(DEFAULT_ASSISTANT_NAME));

  it('defaults to "Brad AI" before any set call', () => {
    expect(getAssistantName()).toBe('Brad AI');
  });

  it('returns the value set at boot', () => {
    setAssistantName('MicroVitamin');
    expect(getAssistantName()).toBe('MicroVitamin');
  });
});

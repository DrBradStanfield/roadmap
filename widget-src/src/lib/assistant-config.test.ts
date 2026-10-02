import { describe, it, expect, beforeEach } from 'vitest';
import {
  resolveAssistantName,
  getAssistantName,
  setAssistantName,
  DEFAULT_ASSISTANT_NAME,
  resolveChatSurface,
  resolveSkipEmailGate,
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

// US-15 AC12: `data-surface` from the shop metafield `health_roadmap.chat_surface`.
describe('resolveChatSurface', () => {
  const root = (surface?: string) => ({ dataset: surface === undefined ? {} : { surface } }) as unknown as HTMLElement;

  it('reads "brand" from the data attribute', () => {
    expect(resolveChatSurface(root('brand'))).toBe('brand');
    expect(resolveChatSurface(root(' brand '))).toBe('brand');
  });

  it('defaults to "doctor" when absent, blank, unknown or rootless', () => {
    expect(resolveChatSurface(root())).toBe('doctor');
    expect(resolveChatSurface(root(''))).toBe('doctor');
    expect(resolveChatSurface(root('Brand!'))).toBe('doctor');
    expect(resolveChatSurface(null)).toBe('doctor');
  });
});

describe('resolveSkipEmailGate (US-44 AC1)', () => {
  const root = (skipEmailGate?: string) =>
    ({ dataset: skipEmailGate === undefined ? {} : { skipEmailGate } }) as unknown as HTMLElement;

  it('is on only for the literal "true" the checkbox renders', () => {
    expect(resolveSkipEmailGate(root('true'))).toBe(true);
    expect(resolveSkipEmailGate(root(' true '))).toBe(true);
  });

  it('stays off for "false", blank, a missing attribute or no root', () => {
    expect(resolveSkipEmailGate(root('false'))).toBe(false);
    expect(resolveSkipEmailGate(root(''))).toBe(false);
    expect(resolveSkipEmailGate(root('TRUE'))).toBe(false);
    expect(resolveSkipEmailGate(root())).toBe(false);
    expect(resolveSkipEmailGate(null)).toBe(false);
  });
});

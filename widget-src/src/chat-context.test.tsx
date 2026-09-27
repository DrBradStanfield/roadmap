// @vitest-environment jsdom
/**
 * US-15 AC10: the blog chat bubble and the chatbot embed send the person's
 * saved profile and saved values — the same inputs their plan reads. A
 * returning user with a saved weight is not treated as empty.
 *
 * Both bundles read the widget's localStorage copy. For a returning user the
 * form fields are empty (their values are saved as measurements), so the copy's
 * `inputs` hold only the profile and the numbers sit in `previousMeasurements`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act } from 'react';
import { renderHook } from '@testing-library/react';
import type { ApiMeasurement, ApiMedication, ApiScreening, ChatContextPayload } from '@roadmap/health-core';
import {
  clearLocalStorage, loadFromLocalStorage, loadGuestInputs, patchMirror, saveToLocalStorage, saveUnitPreference,
  MIRROR_CHANGED_EVENT, MIRROR_KEY,
} from './lib/storage';
import { sendMessage } from './lib/chat-api';
import { useChatState } from './hooks/useChatState';

vi.mock('./lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('./lib/chat-api', () => ({
  sendMessage: vi.fn(async () => ({ result: { conversationId: 'c1', messageId: null, content: 'ok' }, error: null })),
  listConversations: vi.fn(), loadConversation: vi.fn(), deleteConversation: vi.fn(),
}));
vi.mock('./lib/chat-sync', () => ({
  postSync: vi.fn(), postInputSync: vi.fn(), subscribeSync: () => () => {}, generateInstanceId: () => 'test',
}));

const captured: { embed?: Record<string, unknown>; section?: Record<string, unknown> } = {};
vi.mock('./components/ChatEmbed', () => ({
  ChatEmbed: (props: Record<string, unknown>) => { captured.embed = props; return null; },
}));
vi.mock('./components/ChatSection', () => ({
  ChatSection: (props: Record<string, unknown>) => { captured.section = props; return null; },
}));

const row = (metricType: string, value: number): ApiMeasurement => ({
  id: metricType, metricType, value, recordedAt: '2026-09-01T00:00:00Z', createdAt: '2026-09-01T00:00:00Z',
});

const PROFILE = { heightCm: 178, sex: 'male' as const, birthYear: 1970, unitSystem: 'si' as const };
const SAVED = [row('weight', 82), row('ldl', 3.1)];

/** What HealthTool writes on load for a returning user: the record's profile
 *  as `inputs`, the newest saved row per metric beside it. */
function seedReturningUser() {
  saveToLocalStorage(PROFILE, SAVED, [], []);
}

/** The context a chat surface would send now: it hands the chat a reader. */
const contextNow = (guestInputs: unknown) => (guestInputs as () => Record<string, unknown> | null)();

async function mountEntry(rootId: string, entry: () => Promise<unknown>) {
  const root = document.createElement('div');
  root.id = rootId;
  document.body.appendChild(root);
  await act(async () => { await entry(); });
}

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '';
  delete captured.embed;
  delete captured.section;
  vi.resetModules();
});

describe('US-15 AC10: the chat reads the inputs the plan reads', () => {
  it('US-15 AC10: loadGuestInputs fills the empty fields from the saved values', () => {
    seedReturningUser();
    expect(loadGuestInputs()).toMatchObject({ ...PROFILE, weightKg: 82, ldlC: 3.1, medications: [], screenings: [] });
  });

  it('US-15 AC10: the bubble and the embed send what the widget sends: the unit system and the dated values', () => {
    saveToLocalStorage({ ...PROFILE, unitSystem: 'conventional' }, SAVED, [], []);
    expect(loadGuestInputs()).toMatchObject({
      unitSystem: 'conventional',
      measurementHistory: { weight: [{ date: '2026-09-01', value: 82 }], ldl: [{ date: '2026-09-01', value: 3.1 }] },
    });
  });

  it('US-15 AC10: with no unit system saved, the bubble and the embed send the one the widget detects', () => {
    // A US visitor: US English in a US time zone. Nothing saved a preference.
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('en-US');
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions')
      .mockReturnValue({ timeZone: 'America/New_York' } as Intl.ResolvedDateTimeFormatOptions);
    try {
      saveToLocalStorage({ heightCm: 178, sex: 'male' }, SAVED, [], []);
      expect(loadGuestInputs()?.unitSystem).toBe('conventional');
      // A saved preference wins over the detected one, as in the widget.
      saveUnitPreference('si');
      expect(loadGuestInputs()?.unitSystem).toBe('si');
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('US-15 AC10: a longitudinal value in the mirror\'s inputs (a stale form value an older bundle wrote) never outranks the saved one', () => {
    saveToLocalStorage({ ...PROFILE, weightKg: 80, ldlC: 5 }, SAVED, [], []);
    expect(loadGuestInputs()).toMatchObject({ weightKg: 82, ldlC: 3.1 });
    expect(loadFromLocalStorage()?.inputs).toEqual(PROFILE);
    // With nothing saved, the stale value is not sent at all.
    saveToLocalStorage({ ...PROFILE, weightKg: 80 }, [], [], []);
    expect(loadGuestInputs()?.weightKg).toBeUndefined();
  });

  it('US-15 AC10: saved values with no profile are not treated as empty', () => {
    saveToLocalStorage({}, SAVED, [], []);
    expect(loadGuestInputs()).toMatchObject({ weightKg: 82, ldlC: 3.1 });
  });

  it('US-15 AC10: the chatbot embed sends the saved values and is not muted for a returning user', async () => {
    seedReturningUser();
    await mountEntry('health-chatbot-embed-root', () => import('./chatbot-embed'));
    expect(captured.embed?.muted).toBe(false);
    expect(contextNow(captured.embed?.guestInputs)).toMatchObject({ weightKg: 82, ldlC: 3.1 });
  });

  it('US-15 AC10: the chatbot embed is not muted for a user whose only saved values are blood tests', async () => {
    saveToLocalStorage(PROFILE, [row('ldl', 3.1)], [], []);
    await mountEntry('health-chatbot-embed-root', () => import('./chatbot-embed'));
    expect(captured.embed?.muted).toBe(false);
  });

  it('US-15 AC10: the chatbot embed sends the values saved after the page loaded', async () => {
    await mountEntry('health-chatbot-embed-root', () => import('./chatbot-embed'));
    seedReturningUser(); // the widget on the same page saves after the embed mounted
    expect(contextNow(captured.embed?.guestInputs)).toMatchObject({ weightKg: 82, ldlC: 3.1 });
  });

  it('US-15 AC10: the chat reads a context reader when the message is sent, not when it mounts', async () => {
    let context: ChatContextPayload | null = null;
    const { result } = renderHook(() => useChatState({ isLoggedIn: false, guestInputs: () => context }));
    context = { weightKg: 82, unitSystem: 'si', medications: [], screenings: [] };
    act(() => result.current.actions.handleInputChange('What does my weight mean?'));
    await act(async () => { await result.current.actions.handleSend(); });
    expect(vi.mocked(sendMessage)).toHaveBeenCalledWith('What does my weight mean?', null, context, []);
  });

  it('US-15 AC10: the blog chat bubble sends the saved values', async () => {
    seedReturningUser();
    await mountEntry('health-chat-root', () => import('./site-chat'));
    await act(async () => { (document.querySelector('.chat-fab') as HTMLButtonElement).click(); });
    expect(contextNow(captured.section?.guestInputs)).toMatchObject({ weightKg: 82, ldlC: 3.1 });
  });

  it('US-15 AC10: the blog chat bubble sends the values saved after the page loaded', async () => {
    await mountEntry('health-chat-root', () => import('./site-chat'));
    seedReturningUser(); // another tab saves after the bubble mounted
    await act(async () => { (document.querySelector('.chat-fab') as HTMLButtonElement).click(); });
    expect(contextNow(captured.section?.guestInputs)).toMatchObject({ weightKg: 82, ldlC: 3.1 });
  });
});

describe('US-15 AC10: the mirror has one meaning and one signal', () => {
  const STATIN: ApiMedication = {
    id: 'm1', medicationKey: 'statin', drugName: 'atorvastatin', doseValue: 10, doseUnit: 'mg', updatedAt: '2026-09-01T00:00:00Z',
  };
  const COLONOSCOPY: ApiScreening = { id: 's1', screeningKey: 'colorectal_method', value: 'colonoscopy_10yr', updatedAt: '2026-09-01T00:00:00Z' };

  it('US-15 AC10: every write to the mirror tells an embed on the page', () => {
    const seen = vi.fn();
    window.addEventListener(MIRROR_CHANGED_EVENT, seen);
    try {
      saveToLocalStorage(PROFILE, SAVED, [], []);
      patchMirror({ medications: [STATIN] });
      expect(seen).toHaveBeenCalledTimes(2);
    } finally {
      window.removeEventListener(MIRROR_CHANGED_EVENT, seen);
    }
  });

  it('US-15 AC10: a medication or screening write replaces its own list and keeps the saved profile and values', () => {
    seedReturningUser();
    patchMirror({ medications: [STATIN] });
    patchMirror({ screenings: [COLONOSCOPY] });
    expect(loadFromLocalStorage()).toMatchObject({
      inputs: PROFILE, previousMeasurements: SAVED, medications: [STATIN], screenings: [COLONOSCOPY],
    });
  });

  it('US-11: an erase tells an embed on the page, which mutes', async () => {
    seedReturningUser();
    await mountEntry('health-chatbot-embed-root', () => import('./chatbot-embed'));
    expect(captured.embed?.muted).toBe(false);
    act(() => clearLocalStorage());
    expect(captured.embed?.muted).toBe(true);
    expect(contextNow(captured.embed?.guestInputs)).toBeNull();
  });

  it('US-15 AC10: the bubble and the embed POST no row id, update time or lamport clock', async () => {
    // The mirror holds the store's rows as they are, bookkeeping included.
    saveToLocalStorage(PROFILE, SAVED, [{ ...STATIN, id: 'row-7f3a', lamport: 42 } as ApiMedication],
      [{ ...COLONOSCOPY, id: 'row-9c1e', lamport: 43 } as ApiScreening]);
    const real = await vi.importActual<typeof import('./lib/chat-api')>('./lib/chat-api');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ conversationId: 'c1', content: 'ok' }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    try {
      await real.sendMessage('hi', null, loadGuestInputs());
      const body = String(fetchSpy.mock.calls[0][1]?.body);
      const { guestInputs } = JSON.parse(body);
      expect(guestInputs.medications).toEqual([{ medicationKey: 'statin', drugName: 'atorvastatin', doseValue: 10 }]);
      expect(guestInputs.screenings).toEqual([{ screeningKey: 'colorectal_method', value: 'colonoscopy_10yr' }]);
      for (const leak of ['row-7f3a', 'row-9c1e', '"id"', 'updatedAt', 'lamport', 'createdAt', 'recordedAt', 'T00:00:00', 'doseUnit']) {
        expect(body).not.toContain(leak);
      }
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('US-15 AC10: the chatbot embed hears another tab write the mirror, and no other key', async () => {
    await mountEntry('health-chatbot-embed-root', () => import('./chatbot-embed'));
    expect(captured.embed?.muted).toBe(true);
    // Another tab saved: the value lands, then the browser tells this tab.
    localStorage.setItem(MIRROR_KEY, JSON.stringify({ inputs: PROFILE, previousMeasurements: SAVED }));
    act(() => { window.dispatchEvent(new StorageEvent('storage', { key: 'some_other_key' })); });
    expect(captured.embed?.muted).toBe(true);
    act(() => { window.dispatchEvent(new StorageEvent('storage', { key: MIRROR_KEY })); });
    expect(captured.embed?.muted).toBe(false);
  });
});

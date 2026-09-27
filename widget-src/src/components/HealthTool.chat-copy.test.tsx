// @vitest-environment jsdom
/**
 * US-15 AC10: the widget's localStorage copy has one meaning — the saved
 * profile beside the latest saved measurements. The blog chat bubble and the
 * chatbot embed read it on other pages, where the plan reads only what is
 * saved. A value typed into the form but not yet saved never enters the copy,
 * whichever handler writes it last.
 *
 * The widget renders over a real RoadmapStore on this browser's localStorage.
 * The form itself is replaced by a stub that hands back HealthTool's handlers,
 * so a typed value stays unsaved for as long as the test wants.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor, act } from '@testing-library/react';
import type { ApiMedication } from '@roadmap/health-core';
import { loadFromLocalStorage, loadGuestInputs, saveToLocalStorage, MIRROR_CHANGED_EVENT } from '../lib/storage';
import { seedGuest, useHealthToolLifecycle } from '../testing/health-tool-harness';
import { LocalStorageAdapter } from '../storage/local-storage-adapter';
import { REMOTE_CHANGED_EVENT } from '../storage/roadmap-store';
import { initRoadmapStore, loadLatestMeasurements, saveMedication, saveScreening } from '../lib/roadmap-data';

vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/server-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/server-api')>()),
  trackProductEvent: vi.fn(),
  trackABImpression: vi.fn(),
  trackABConversion: vi.fn(),
}));
vi.mock('../lib/chat-api', () => ({ listConversations: () => Promise.resolve(null), getChatGate: () => null }));
// The real saves, which a test can make fail once.
vi.mock('../lib/roadmap-data', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/roadmap-data')>();
  return { ...real, saveMedication: vi.fn(real.saveMedication), saveScreening: vi.fn(real.saveScreening) };
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const chat = vi.hoisted(() => ({ props: null as null | Record<string, any> }));
vi.mock('./ChatEmbed', () => ({ ChatEmbed: (props: Record<string, unknown>) => { chat.props = props; return null; } }));
vi.mock('./ChatSection', () => ({ ChatSection: () => null }));
vi.mock('./UploadModal', () => ({ UploadModal: () => null }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const panel = vi.hoisted(() => ({ props: null as null | Record<string, any> }));
vi.mock('./InputPanel', () => ({
  InputPanel: (props: Record<string, unknown>) => { panel.props = props; return null; },
}));

import { HealthTool } from './HealthTool';

/** A returning guest: a saved profile and a saved weight of 82 kg. The
 *  page has read the record once `previousMeasurements` reaches the form. */
async function returningGuest() {
  await seedGuest({ sex: 'male', heightCm: 178, birthYear: 1970 }, [['weight', 82]]);
  render(<HealthTool />);
  await waitFor(() => expect(panel.props?.previousMeasurements).toHaveLength(1));
}

useHealthToolLifecycle();
beforeEach(() => { panel.props = null; chat.props = null; });

describe('US-15 AC10: the chat copy holds what is saved, never an unsaved typed value', () => {
  it('US-15 AC10: a medication change writes the saved profile, not the half-typed form', async () => {
    await returningGuest();
    act(() => panel.props!.onChange('weightKg', 80)); // typed, not saved
    act(() => panel.props!.onMedicationChange('statin', 'atorvastatin', 10, 'mg'));

    await waitFor(() => expect(loadGuestInputs()).toMatchObject({ weightKg: 82, medications: [expect.objectContaining({ medicationKey: 'statin' })] }));
    expect(loadFromLocalStorage()!.inputs).toEqual({ sex: 'male', heightCm: 178, birthYear: 1970 });
  });

  it('US-15 AC10: a screening change writes the saved profile, not the half-typed form', async () => {
    await returningGuest();
    act(() => panel.props!.onChange('weightKg', 80)); // typed, not saved
    act(() => panel.props!.onScreeningChange('colorectal_method', 'colonoscopy'));

    await waitFor(() => expect(loadGuestInputs()).toMatchObject({ weightKg: 82, screenings: [expect.objectContaining({ screeningKey: 'colorectal_method' })] }));
    expect(loadFromLocalStorage()!.inputs).toEqual({ sex: 'male', heightCm: 178, birthYear: 1970 });
  });

  it('US-15 AC10: a save tells the chatbot embed once the copy holds the saved value', async () => {
    await returningGuest();
    // What an embed on the same page reads each time it is told (chatbot-embed.tsx).
    const seen: unknown[] = [];
    const listener = () => seen.push(loadGuestInputs()?.weightKg);
    window.addEventListener(MIRROR_CHANGED_EVENT, listener);
    try {
      act(() => panel.props!.onChange('weightKg', 80));
      act(() => panel.props!.flushLongitudinalSave()); // the field is left: it saves
      await waitFor(() => expect(seen.at(-1)).toBe(80));
    } finally {
      window.removeEventListener(MIRROR_CHANGED_EVENT, listener);
    }
  });

  it('US-15 AC10: a keystroke neither writes the copy nor tells the embed', async () => {
    await returningGuest();
    const before = localStorage.getItem('health_roadmap_data');
    const seen = vi.fn();
    window.addEventListener(MIRROR_CHANGED_EVENT, seen);
    try {
      act(() => panel.props!.onChange('weightKg', 80)); // typed, not saved
      expect(seen).not.toHaveBeenCalled();
      expect(localStorage.getItem('health_roadmap_data')).toBe(before);
    } finally {
      window.removeEventListener(MIRROR_CHANGED_EVENT, seen);
    }
  });

  it('US-15 AC11: the widget chat reads the context through one reader, which stays the same across renders', async () => {
    await returningGuest();
    const reader = chat.props!.guestInputs as () => Record<string, unknown>;
    act(() => panel.props!.onMedicationChange('statin', 'atorvastatin', 10, 'mg'));
    expect(chat.props!.guestInputs).toBe(reader);
    await waitFor(() => expect(reader()).toMatchObject({
      weightKg: 82,
      unitSystem: 'si',
      medications: [expect.objectContaining({ medicationKey: 'statin', drugName: 'atorvastatin' })],
      measurementHistory: { weight: [{ date: '2026-09-01', value: 82 }] },
    }));
  });

  it('US-15 AC11: the widget chat\'s payload carries no row id, update time or lamport clock', async () => {
    await returningGuest();
    act(() => panel.props!.onMedicationChange('statin', 'atorvastatin', 10, 'mg'));
    const reader = chat.props!.guestInputs as () => Record<string, unknown>;
    await waitFor(() => expect(reader().medications).toEqual([
      { medicationKey: 'statin', drugName: 'atorvastatin', doseValue: 10 },
    ]));
    // The saved row does carry them; the payload must not.
    await waitFor(async () => expect((await loadLatestMeasurements())?.medications[0]).toHaveProperty('updatedAt'), { timeout: 2000 });
    expect(JSON.stringify(reader())).not.toMatch(/"id"|updatedAt|lamport|createdAt|recordedAt|doseUnit/);
  });

  it('US-15 AC10: a profile-only save writes the copy, and a new guest\'s medication keeps the saved profile, not the typed weight', async () => {
    await initRoadmapStore(new LocalStorageAdapter()); // a new guest: nothing saved
    render(<HealthTool />);
    await waitFor(() => expect(panel.props).not.toBeNull());
    act(() => panel.props!.onChange('sex', 'male'));
    act(() => panel.props!.onChange('heightCm', 178));
    // The profile saves itself 500 ms after the last keystroke.
    await waitFor(() => expect(loadFromLocalStorage()?.inputs).toEqual({ sex: 'male', heightCm: 178 }), { timeout: 2000 });

    act(() => panel.props!.onChange('weightKg', 80)); // typed, not saved
    act(() => panel.props!.onMedicationChange('statin', 'atorvastatin', 10, 'mg'));

    await waitFor(() => expect(loadFromLocalStorage()).toMatchObject({
      inputs: { sex: 'male', heightCm: 178 },
      previousMeasurements: [],
      medications: [expect.objectContaining({ medicationKey: 'statin', drugName: 'atorvastatin' })],
    }));
    expect(loadGuestInputs()?.weightKg).toBeUndefined();
  });

  const statinOnRecord = async () => (await loadLatestMeasurements())?.medications
    .some((m: ApiMedication) => m.medicationKey === 'statin') ?? false;

  it('US-15 AC10: a medication or screening save that fails leaves no row in the chat copy', async () => {
    await returningGuest();
    vi.mocked(saveMedication).mockResolvedValueOnce(false);
    vi.mocked(saveScreening).mockResolvedValueOnce(false);
    act(() => panel.props!.onMedicationChange('statin', 'atorvastatin', 10, 'mg'));
    act(() => panel.props!.onScreeningChange('colorectal_method', 'colonoscopy'));
    await waitFor(() => expect(saveMedication).toHaveBeenCalled());
    await waitFor(() => expect(saveScreening).toHaveBeenCalled());
    await act(async () => { await new Promise(r => setTimeout(r, 50)); }); // the saves resolve

    expect(await statinOnRecord()).toBe(false);
    expect(loadFromLocalStorage()).toMatchObject({ medications: [], screenings: [] });
  });

  it('US-15 AC10: a re-read while a medication save waits does not leave the chat copy without it', async () => {
    await returningGuest();
    act(() => panel.props!.onMedicationChange('statin', 'atorvastatin', 10, 'mg'));
    // Another device writes inside the 300 ms before the save: the page
    // re-reads the record, which has no statin yet.
    act(() => { window.dispatchEvent(new Event(REMOTE_CHANGED_EVENT)); });
    await waitFor(async () => expect(await statinOnRecord()).toBe(true));

    await waitFor(() => expect(loadFromLocalStorage()?.medications)
      .toEqual([expect.objectContaining({ medicationKey: 'statin', drugName: 'atorvastatin' })]));
  });
});

describe('US-11: an erase on another device reaches the chat copy', () => {
  it('US-11: a page that loads an empty record empties the chat copy, so the bubble and the embed send nothing', async () => {
    // What this device's copy held before another device erased the record.
    saveToLocalStorage({ sex: 'male', heightCm: 178 }, [{
      id: 'w', metricType: 'weight', value: 82, recordedAt: '2026-09-01T00:00:00Z', createdAt: '2026-09-01T00:00:00Z',
    }], [{ id: 'm', medicationKey: 'statin', drugName: 'atorvastatin', doseValue: 10, doseUnit: 'mg', updatedAt: '2026-09-01T00:00:00Z' }], []);
    await initRoadmapStore(new LocalStorageAdapter()); // the record, erased
    const told = vi.fn();
    window.addEventListener(MIRROR_CHANGED_EVENT, told);
    try {
      render(<HealthTool />);
      await waitFor(() => expect(loadGuestInputs()).toBeNull());
      expect(loadFromLocalStorage()).toMatchObject({ inputs: {}, previousMeasurements: [], medications: [], screenings: [] });
      expect(told).toHaveBeenCalled();
    } finally {
      window.removeEventListener(MIRROR_CHANGED_EVENT, told);
    }
  });
});

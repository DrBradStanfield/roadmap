// Test support: one pick run through the shared upload state (health-core upload-flow.ts) with
// the web's real effects (lib/upload-effects.ts), as hooks/useUploadFlow.ts runs them, with no
// React. The caller stubs the transport (fetch or labImport) and hands the upload bundle in.
// Imported by tests only.
import { initialUpload, transition, type PickedFile, type UploadEvent, type UploadState } from '@roadmap/health-core/upload-flow';
import { runEffect, type UploadPort } from '../lib/upload-effects';
import { emptyHeld, readOutcome, type Held } from '../lib/upload-read';
import { isZip } from '../lib/file-kinds';
import type { HealthUploadAPI } from '../upload-entry';

export interface Driven {
  state: () => UploadState;
  held: Held;
  /** Every state the run passed through, in order. */
  states: UploadState[];
  send: (event: UploadEvent) => void;
  /** The review's results and the notices, as the modal is handed them. */
  outcome: (cloud?: boolean) => ReturnType<typeof readOutcome>;
}

/** Starts a run of `files` (a ZIP by its name) and returns its handle; the effects run on. */
export function drive(upload: HealthUploadAPI, files: File[]): Driven {
  let s: UploadState = initialUpload('web');
  const held = emptyHeld(1);
  const states: UploadState[] = [];
  const port: UploadPort = {
    live: () => s,
    held: () => held,
    send: (event) => {
      const step = transition(s, event);
      if (step.state === s) return;
      s = step.state;
      states.push(s);
      for (const effect of step.effects) runEffect(port, effect);
    },
    prepare: async () => upload,
    reads: new Map(),
    unitSystem: 'si',
    save: () => {},
  };
  const picked: PickedFile[] = files.map((f, i) => {
    held.files.set(`f${i}`, { file: f });
    return { id: `f${i}`, name: f.name, bytes: f.size, kind: isZip(f) ? 'zip' : 'file' };
  });
  port.send({ type: 'picked', files: picked, needsConsent: false, now: new Date().toISOString() });
  return { state: () => s, held, states, send: port.send, outcome: () => readOutcome(s, held) };
}

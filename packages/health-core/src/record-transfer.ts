/**
 * Moving the record between this device's copy and a cloud, outside a
 * session: the lift on first connect and the copy-down before a switch
 * (US-09 AC2, AC3, AC4, AC23). Shared by the web widget and the iPhone app
 * (ios/architecture.md D4). Both are plain merges: against an erased cloud,
 * the rows this device holds survive because no erase listed them.
 * No DOM and no Node: engine-portability.test.ts checks.
 */
import { ROADMAP_FILE_NAME } from './adapter';
import type { RecordHost } from './record-host';
import { saveRecordInto } from './record-session';
import { ROADMAP_DOC } from './roadmap-doc';
import { SyncManager, type SyncContext } from './sync-manager';

type CloudHost = Extract<RecordHost, { tier: 'cloud' }>;

function ctxOf(host: RecordHost): SyncContext {
  return { deviceId: host.deviceId(), now: new Date(host.clock.now()).toISOString() };
}

/**
 * First connect: merge this device's copy up into the cloud (US-09 AC3). A
 * device copy that cannot be read is skipped: it is unrecoverable anyway, and
 * must never block the connect. A failed cloud save marks the device copy
 * pending, so the next session (which opens right after) and every later one
 * merge it up, and is re-thrown for the caller to report (US-09 AC4).
 */
export async function liftDeviceCopy(host: CloudHost): Promise<'lifted' | 'empty' | 'unreadable'> {
  let body: unknown;
  try {
    ({ body } = await host.mirror.adapter.read(ROADMAP_FILE_NAME));
  } catch {
    return 'unreadable';
  }
  if (body == null) return 'empty';
  try {
    await saveRecordInto(host.store, body, ctxOf(host));
  } catch (error) {
    host.mirror.pending.set();
    throw error;
  }
  return 'lifted';
}

/**
 * Before leaving a cloud: copy its record down onto this device, merged
 * (US-09 AC2). A cloud that cannot be read throws, and the caller stops the
 * switch; the cloud file itself is never written.
 */
export async function copyCloudDown(host: CloudHost): Promise<void> {
  const { body } = await host.store.read(ROADMAP_FILE_NAME);
  if (body == null) return;
  const ctx = ctxOf(host);
  const device = new SyncManager(host.mirror.adapter, ctx.deviceId, ROADMAP_DOC, { now: () => ctx.now });
  await device.save(ROADMAP_DOC.merge(await device.load(), ROADMAP_DOC.migrate(body, ctx), ctx));
}

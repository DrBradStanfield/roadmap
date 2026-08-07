/**
 * Reading a RoadmapFile from the user's cloud is an untrusted boundary: the
 * bytes may be a different schema version, a partial/corrupt write, or a file
 * written by a NEWER app version on another device. `migrate.ts` is the single
 * gate that turns raw parsed JSON into a safe, fully-formed `RoadmapFile`.
 *
 * Forward-compat rules (implementation plan §15 H7):
 *  1. NEVER strip unknown fields — an older app must round-trip fields a newer
 *     app added. We achieve this by spreading the raw object first, then filling
 *     in only the known/required shape; extras survive to the next write.
 *  2. If the file's schemaVersion is NEWER than this app understands, refuse to
 *     migrate (the caller must gate writes — "please update the app") rather
 *     than silently downgrading and corrupting newer data.
 *
 * There is intentionally NO back-compat migration *layer* at v1 (the schema is
 * built clean). Add a `case` per version here only if the shape ever changes.
 */
import {
  CURRENT_SCHEMA_VERSION,
  createEmptyFile,
  type RoadmapFile,
} from './roadmap-file';

/** Thrown when a file was written by a newer app version than this one. */
export class SchemaTooNewError extends Error {
  constructor(public fileVersion: number, public appVersion: number) {
    super(
      `Health Roadmap file is schema v${fileVersion}, but this app only understands v${appVersion}. ` +
        `Update the app before writing, or your newer data could be lost.`,
    );
    this.name = 'SchemaTooNewError';
  }
}

/** Guard for the untrusted-JSON boundary — shared by every synced-file migrate. */
export function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

export function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

/**
 * Normalise raw parsed JSON into a complete RoadmapFile.
 *
 * @param raw    The result of JSON.parse on the file bytes (or null/garbage).
 * @param opts   deviceId + now, used only to synthesise meta for a fresh/blank file.
 * @throws SchemaTooNewError if raw.schemaVersion > CURRENT_SCHEMA_VERSION.
 */
export function migrateFile(
  raw: unknown,
  opts: { deviceId: string; now: string },
): RoadmapFile {
  // Empty / unreadable → a fresh record.
  if (!isObject(raw)) {
    return createEmptyFile(opts);
  }

  const version = typeof raw.schemaVersion === 'number' ? raw.schemaVersion : CURRENT_SCHEMA_VERSION;

  // Refuse to downgrade a newer file (forward-compat rule 2).
  if (version > CURRENT_SCHEMA_VERSION) {
    throw new SchemaTooNewError(version, CURRENT_SCHEMA_VERSION);
  }

  // --- v1 normalisation -----------------------------------------------------
  // Spread `raw` FIRST so any unknown top-level fields survive (rule 1), then
  // overwrite with a guaranteed-present, well-typed shape.
  const base = createEmptyFile(opts);
  const rawMeta = isObject(raw.meta) ? raw.meta : {};
  const rawProfile = isObject(raw.profile) ? raw.profile : {};
  const rawScreenings = isObject(raw.screenings) ? raw.screenings : {};

  return {
    ...(raw as Record<string, unknown>),
    schemaVersion: CURRENT_SCHEMA_VERSION,
    // Spread rawMeta FIRST (rule 1 applies to meta too): rebuilding only the
    // known fields silently dropped everything else — including `eraseEpoch`,
    // which broke the "Delete All My Data" wholesale-win guarantee on every
    // read (a stale device's flush resurrected erased data; US-11 regression
    // tests in roadmap-store-data-safety.test.ts / sync-manager.test.ts).
    meta: {
      ...rawMeta,
      createdAt: typeof rawMeta.createdAt === 'string' ? rawMeta.createdAt : base.meta.createdAt,
      updatedAt: typeof rawMeta.updatedAt === 'string' ? rawMeta.updatedAt : base.meta.updatedAt,
      lastDeviceId: typeof rawMeta.lastDeviceId === 'string' ? rawMeta.lastDeviceId : base.meta.lastDeviceId,
      lamport: typeof rawMeta.lamport === 'number' ? rawMeta.lamport : base.meta.lamport,
      eraseEpoch: typeof rawMeta.eraseEpoch === 'number' && Number.isFinite(rawMeta.eraseEpoch)
        ? rawMeta.eraseEpoch
        : base.meta.eraseEpoch,
    },
    profile: {
      ...rawProfile,
      updatedAt: typeof rawProfile.updatedAt === 'string' ? rawProfile.updatedAt : base.profile.updatedAt,
    },
    measurements: asArray(raw.measurements),
    medications: asArray(raw.medications),
    medicationHistory: asArray(raw.medicationHistory),
    supplements: asArray(raw.supplements),
    supplementHistory: asArray(raw.supplementHistory),
    screenings: {
      ...rawScreenings,
      updatedAt: typeof rawScreenings.updatedAt === 'string' ? rawScreenings.updatedAt : base.screenings.updatedAt,
    },
    labValues: asArray(raw.labValues),
    documents: asArray(raw.documents),
    reminderPreferences: asArray(raw.reminderPreferences),
    recommendationSnapshots: asArray(raw.recommendationSnapshots),
  } as RoadmapFile;
}

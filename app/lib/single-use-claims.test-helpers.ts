/**
 * An in-memory stand-in for the admin client, enough for `single_use_claims`:
 * a primary-key insert that answers 23505 on a repeat, and the delete of old
 * rows of one kind or of one key. Every other table is inert, so a suite that mocks the admin
 * client with this keeps its product events quiet. The state is the caller's,
 * made in `vi.hoisted`, so module resets in a suite still share one store.
 */
export interface ClaimsState {
  rows: Map<string, { kind: string; createdAt: number }>;
  /**
   * 'throw': the client rejects and nothing is stored. 'error': it answers an
   * error, as a missing table does. 'commit-then-throw': the row is stored,
   * then the reply is lost. 'hang': the insert answers only when aborted.
   */
  down: false | 'throw' | 'error' | 'commit-then-throw' | 'hang';
  /** Inserts that reached the store, whatever they answered. */
  inserts: number;
  /** The old-row delete: 'hang' never settles, 'reject' rejects, 'build-throws' throws as the query is built. */
  cleanup: false | 'hang' | 'reject' | 'build-throws';
  /** The abort signal each delete was sent with (undefined: none). */
  deleteSignals: Array<AbortSignal | undefined>;
}

export function newClaimsState(): ClaimsState {
  return { rows: new Map(), down: false, inserts: 0, cleanup: false, deleteSignals: [] };
}

/** Back to an empty, reachable store. */
export function resetClaimsState(state: ClaimsState): void {
  state.rows.clear();
  state.down = false;
  state.inserts = 0;
  state.cleanup = false;
  state.deleteSignals = [];
}

const OK = { data: null, error: null };
const MISSING = { data: null, error: { code: 'PGRST205', message: 'table not found' } };

/** Any chain on another table resolves to an empty success. */
const inert: unknown = new Proxy(() => undefined, {
  get: (_target, prop) => (prop === 'then' ? (resolve: (v: unknown) => void) => resolve(OK) : inert),
  apply: () => inert,
});

export function claimsAdmin(state: ClaimsState) {
  const reach = () => {
    if (state.down === 'throw') throw new Error('fetch failed');
    return state.down !== 'error';
  };
  async function insert(row: { key: string; kind: string }, signal?: AbortSignal) {
    state.inserts++;
    if (state.down === 'hang') {
      // As supabase-js answers an aborted fetch: an error, not a throw.
      return new Promise<typeof MISSING>((resolve) => signal?.addEventListener('abort', () => resolve({ data: null, error: { code: '', message: 'AbortError' } })));
    }
    if (!reach()) return MISSING;
    if (state.rows.has(row.key)) return { data: null, error: { code: '23505', message: 'duplicate key value' } };
    state.rows.set(row.key, { kind: row.kind, createdAt: Date.now() });
    if (state.down === 'commit-then-throw') throw new Error('fetch failed');
    return OK;
  }
  return {
    from(table: string) {
      if (table !== 'single_use_claims') return inert;
      return {
        insert: (row: { key: string; kind: string }) => ({
          abortSignal: (signal: AbortSignal) => insert(row, signal),
          then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => insert(row).then(resolve, reject),
        }),
        delete: () => {
          if (state.cleanup === 'build-throws') throw new Error('query build failed');
          // Each delete is a thenable with `abortSignal`, as supabase-js builds it.
          const run = (apply: () => void) => {
            const exec = async (signal?: AbortSignal) => {
              state.deleteSignals.push(signal);
              if (state.cleanup === 'hang') {
                // As supabase-js answers an aborted fetch: an error, not a throw. Unaborted, it never settles.
                return new Promise<typeof MISSING>((resolve) => signal?.addEventListener('abort', () => resolve({ data: null, error: { code: '', message: 'AbortError' } })));
              }
              if (state.cleanup === 'reject') throw new Error('fetch failed');
              if (!reach()) return MISSING;
              apply();
              return OK;
            };
            return {
              abortSignal: (signal: AbortSignal) => exec(signal),
              then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => exec().then(resolve, reject),
            };
          };
          return {
            eq: (_column: 'kind', kind: string) => ({
              /** Old rows of one kind. */
              lt: (_column: 'created_at', iso: string) => run(() => {
                for (const [key, row] of state.rows) if (row.kind === kind && row.createdAt < Date.parse(iso)) state.rows.delete(key);
              }),
              /** One claim, by its key. */
              eq: (_column: 'key', key: string) => run(() => {
                if (state.rows.get(key)?.kind === kind) state.rows.delete(key);
              }),
            }),
          };
        },
      };
    },
  };
}

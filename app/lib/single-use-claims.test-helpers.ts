/**
 * An in-memory stand-in for the admin client, enough for `single_use_claims`:
 * a primary-key insert that answers 23505 on a repeat (and, with
 * `.select('created_at').single()`, returns its row's created_at as PostgREST
 * does, with microseconds), and a delete filtered by `eq` and `lt`. Every other
 * table is inert, so a suite that mocks the admin client with this keeps its
 * product events quiet. The state is the caller's, made in `vi.hoisted`, so
 * module resets in a suite still share one store.
 */
export interface ClaimsState {
  /** `createdAtIso` is what PostgREST would print; a row set by hand without it never matches an `eq` on created_at. */
  rows: Map<string, { kind: string; createdAt: number; createdAtIso?: string }>;
  /**
   * 'throw': the client rejects and nothing is stored. 'error': it answers an
   * error, as a missing table does. 'commit-then-throw': the row is stored,
   * then the reply is lost. 'hang': the insert answers only when aborted.
   */
  down: false | 'throw' | 'error' | 'commit-then-throw' | 'hang';
  /** Inserts that reached the store, whatever they answered. */
  inserts: number;
  /** The delete: 'hang' never settles unaborted, 'reject' rejects, 'build-throws' throws as the query is built. */
  cleanup: false | 'hang' | 'reject' | 'build-throws';
  /** The abort signal each delete was sent with (undefined: none). */
  deleteSignals: Array<AbortSignal | undefined>;
  /** Each delete's filters, in order: [op, column, value]. */
  deleteFilters: Array<Array<[string, string, string]>>;
  /** A slow store: every insert and delete waits this long first, unless aborted. */
  delayMs: number;
}

export function newClaimsState(): ClaimsState {
  return { rows: new Map(), down: false, inserts: 0, cleanup: false, deleteSignals: [], deleteFilters: [], delayMs: 0 };
}

/** Back to an empty, reachable store. */
export function resetClaimsState(state: ClaimsState): void {
  state.rows.clear();
  state.down = false;
  state.inserts = 0;
  state.cleanup = false;
  state.deleteSignals = [];
  state.deleteFilters = [];
  state.delayMs = 0;
}

const OK = { data: null, error: null };
const MISSING = { data: null, error: { code: 'PGRST205', message: 'table not found' } };
/** As supabase-js answers an aborted fetch: an error, not a throw. */
const ABORTED = { data: null, error: { code: '', message: 'AbortError' } };

/** Any chain on another table resolves to an empty success. */
const inert: unknown = new Proxy(() => undefined, {
  get: (_target, prop) => (prop === 'then' ? (resolve: (v: unknown) => void) => resolve(OK) : inert),
  apply: () => inert,
});

let micro = 0;
/** A timestamptz as PostgREST prints it: microseconds and an offset, unlike Date#toISOString. */
function pgTimestamp(ms: number): string {
  micro = (micro + 1) % 1000;
  return `${new Date(ms).toISOString().slice(0, 23)}${String(micro).padStart(3, '0')}+00:00`;
}

export function claimsAdmin(state: ClaimsState) {
  const reach = () => {
    if (state.down === 'throw') throw new Error('fetch failed');
    return state.down !== 'error';
  };
  /** True when the slow store's wait ran out; false when aborted first. */
  const wait = (signal?: AbortSignal) => new Promise<boolean>((resolve) => {
    if (signal?.aborted) return resolve(false);
    if (!state.delayMs) return resolve(true);
    const timer = setTimeout(() => resolve(true), state.delayMs);
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(false); });
  });
  async function insert(row: { key: string; kind: string }, signal: AbortSignal | undefined, returning: boolean) {
    state.inserts++;
    if (state.down === 'hang') return new Promise<typeof ABORTED>((resolve) => signal?.addEventListener('abort', () => resolve(ABORTED)));
    if (!(await wait(signal))) return ABORTED;
    if (!reach()) return MISSING;
    if (state.rows.has(row.key)) return { data: null, error: { code: '23505', message: 'duplicate key value' } };
    const createdAt = Date.now();
    const createdAtIso = pgTimestamp(createdAt);
    state.rows.set(row.key, { kind: row.kind, createdAt, createdAtIso });
    if (state.down === 'commit-then-throw') throw new Error('fetch failed');
    return returning ? { data: { created_at: createdAtIso }, error: null } : OK;
  }
  const thenable = (run: (signal?: AbortSignal) => Promise<unknown>) => ({
    abortSignal: (signal: AbortSignal) => run(signal),
    then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => run().then(resolve, reject),
  });
  return {
    from(table: string) {
      if (table !== 'single_use_claims') return inert;
      return {
        insert: (row: { key: string; kind: string }) => ({
          ...thenable((signal) => insert(row, signal, false)),
          // As the server builds it: `.select('created_at').abortSignal(signal).single()`.
          select: (_columns: 'created_at') => {
            let signal: AbortSignal | undefined;
            const returning = {
              abortSignal: (s: AbortSignal) => { signal = s; return returning; },
              single: () => ({ then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => insert(row, signal, true).then(resolve, reject) }),
            };
            return returning;
          },
        }),
        delete: () => {
          if (state.cleanup === 'build-throws') throw new Error('query build failed');
          const filters: Array<[string, string, string]> = [];
          const matches = (key: string, row: { kind: string; createdAt: number; createdAtIso?: string }) => filters.every(([op, column, value]) => {
            const field = column === 'key' ? key : column === 'kind' ? row.kind : row.createdAtIso;
            if (op === 'eq') return field === value;
            return column === 'created_at' && row.createdAt < Date.parse(value);
          });
          const exec = async (signal?: AbortSignal) => {
            state.deleteSignals.push(signal);
            state.deleteFilters.push(filters);
            if (state.cleanup === 'hang') return new Promise<typeof ABORTED>((resolve) => signal?.addEventListener('abort', () => resolve(ABORTED)));
            if (state.cleanup === 'reject') throw new Error('fetch failed');
            if (!(await wait(signal))) return ABORTED;
            if (!reach()) return MISSING;
            for (const [key, row] of state.rows) if (matches(key, row)) state.rows.delete(key);
            return OK;
          };
          const builder = {
            eq: (column: 'kind' | 'key' | 'created_at', value: string) => { filters.push(['eq', column, value]); return builder; },
            lt: (column: 'created_at', value: string) => { filters.push(['lt', column, value]); return builder; },
            ...thenable(exec),
          };
          return builder;
        },
      };
    },
  };
}

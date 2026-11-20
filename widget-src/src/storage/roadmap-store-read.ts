// The store's first read of the record, as its open takes it (US-66 AC13, AC14): moved from
// roadmap-store.ts unchanged, so that file does not grow (file budget).
import { ROADMAP_FILE_NAME, type StorageAdapter } from '@roadmap/health-core/adapter';

/** `adapter`, with its first read of the record handed to `seen`: the stored
 *  bytes the open migrates (US-66 AC14). Every other call passes through. */
export function tapFirstRead(adapter: StorageAdapter, seen: (body: unknown) => void): StorageAdapter {
  let first = true;
  return new Proxy(adapter, {
    get(target, prop) {
      if (prop === 'read') {
        return async (fileName: string, signal?: AbortSignal) => {
          const result = await target.read(fileName, signal);
          if (first && fileName === ROADMAP_FILE_NAME) { first = false; seen(result.body); }
          return result;
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** A stored body's rows, junk left out, as `bloodTableReport` reads them. */
export function storedRows<T>(body: Record<string, unknown>, key: string): T[] {
  const rows = body[key];
  return Array.isArray(rows) ? rows.filter((row): row is T => typeof row === 'object' && row !== null) : [];
}

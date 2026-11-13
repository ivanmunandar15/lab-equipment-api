import { env, isTest } from '../config/env';

interface Entry {
  expires: number;
  value: unknown;
}

const store = new Map<string, Entry>();
const inflight = new Map<string, Promise<unknown>>();

/**
 * Cache in-memory singkat. Request bersamaan untuk key yang sama berbagi satu query (anti-stampede).
 * Nonaktif saat test atau DASHBOARD_CACHE_SECONDS=0. Dengan banyak instance, tiap instance punya cache sendiri.
 */
export async function cached<T>(key: string, load: () => Promise<T>, ttlSeconds = env.DASHBOARD_CACHE_SECONDS): Promise<T> {
  if (isTest || ttlSeconds <= 0) return load();
  const now = Date.now();
  const hit = store.get(key);
  if (hit && hit.expires > now) return hit.value as T;
  const pending = inflight.get(key);
  if (pending) return pending as Promise<T>;
  const p = load()
    .then((value) => {
      store.set(key, { value, expires: Date.now() + ttlSeconds * 1000 });
      return value;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

export const clearCache = () => store.clear();

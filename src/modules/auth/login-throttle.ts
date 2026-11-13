import { isTest } from '../../config/env';

/**
 * Penundaan progresif setelah login gagal berulang (per email+IP).
 * In-memory: cukup untuk satu instance. Untuk multi-instance pindahkan ke Redis.
 */
const FREE_ATTEMPTS = 3;
const WINDOW_MS = 15 * 60 * 1000;
const MAX_DELAY_MS = 5000;

const attempts = new Map<string, { count: number; last: number }>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function current(key: string) {
  const e = attempts.get(key);
  if (e && Date.now() - e.last > WINDOW_MS) {
    attempts.delete(key);
    return undefined;
  }
  return e;
}

export const loginThrottle = {
  async wait(key: string) {
    if (isTest) return;
    const e = current(key);
    if (!e || e.count < FREE_ATTEMPTS) return;
    await sleep(Math.min(500 * 2 ** (e.count - FREE_ATTEMPTS), MAX_DELAY_MS));
  },
  fail(key: string) {
    const e = current(key);
    attempts.set(key, { count: (e?.count ?? 0) + 1, last: Date.now() });
    if (attempts.size > 10_000) for (const k of attempts.keys()) current(k);
  },
  reset(key: string) {
    attempts.delete(key);
  },
};

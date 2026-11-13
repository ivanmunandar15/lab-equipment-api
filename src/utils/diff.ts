import { isDeepStrictEqual } from 'node:util';

export interface FieldChange {
  field: string;
  old: unknown;
  new: unknown;
}

const asObject = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** Daftar field yang berbeda antara old_data dan new_data (perbandingan level atas, nilai nested dibandingkan penuh). */
export function computeDiff(oldData: unknown, newData: unknown): FieldChange[] {
  const o = asObject(oldData);
  const n = asObject(newData);
  const keys = [...new Set([...Object.keys(o), ...Object.keys(n)])];
  return keys
    .filter((k) => !isDeepStrictEqual(o[k], n[k]))
    .map((field) => ({ field, old: o[field] ?? null, new: n[field] ?? null }));
}

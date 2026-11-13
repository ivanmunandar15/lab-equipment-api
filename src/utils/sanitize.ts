import type { Prisma } from '@prisma/client';

/** Nama field yang tidak boleh masuk activity log (dicek pada semua level nested). */
export const SENSITIVE_KEY = /password|passwd|token|secret|api_?key|authorization|cookie/i;
const MAX_BYTES = 64 * 1024;

/**
 * Menghapus field sensitif (password_hash, *token*, dst), mengubah Date/Decimal/BigInt
 * menjadi JSON murni, dan membatasi ukuran. Mengembalikan undefined jika tidak ada data.
 */
export function sanitizeForAudit(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined || value === null) return undefined;
  const json = JSON.stringify(value, (key, v) => {
    if (key && SENSITIVE_KEY.test(key)) return undefined;
    return typeof v === 'bigint' ? v.toString() : v;
  });
  if (json === undefined) return undefined;
  const size = Buffer.byteLength(json);
  if (size > MAX_BYTES) return { _truncated: true, _size_bytes: size };
  return JSON.parse(json) as Prisma.InputJsonValue;
}

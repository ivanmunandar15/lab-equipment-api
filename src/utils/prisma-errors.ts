/** Kembalikan daftar kolom/index dari error unique-violation Prisma (P2002), atau null jika bukan P2002. */
export function uniqueViolation(err: unknown): string | null {
  const e = err as { code?: string; meta?: { target?: unknown } } | null;
  if (e?.code !== 'P2002') return null;
  const t = e.meta?.target;
  return Array.isArray(t) ? t.join(',') : typeof t === 'string' ? t : '';
}

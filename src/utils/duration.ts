const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

/** '15m' | '7d' | '30s' | '2h' → milidetik */
export function parseDurationMs(value: string): number {
  const m = /^(\d+)\s*([smhd])$/.exec(value.trim());
  if (!m) throw new Error(`Durasi tidak valid: ${value}`);
  return Number(m[1]) * UNIT_MS[m[2] as keyof typeof UNIT_MS];
}

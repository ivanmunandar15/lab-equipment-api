import type { Prisma } from '@prisma/client';
import { env } from '../../config/env';

export type CalibrationState = 'safe' | 'due_soon' | 'overdue';

const DAY_MS = 86_400_000;

export const startOfUtcDay = (d: Date = new Date()) =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
export const addUtcDays = (d: Date, n: number) => new Date(d.getTime() + n * DAY_MS);

/** Tanggal `@db.Date` → 'YYYY-MM-DD' (atau null). */
export const dateOnly = (d: Date | null | undefined): string | null => (d ? d.toISOString().slice(0, 10) : null);

/**
 * overdue: tanggal < hari ini; due_soon: hari ini s.d. hari ini + N hari; safe: lebih jauh.
 * null jika alat tidak punya jadwal kalibrasi.
 */
export function calibrationState(
  next: Date | null | undefined,
  now: Date = new Date(),
  dueSoonDays: number = env.CALIBRATION_DUE_SOON_DAYS,
): CalibrationState | null {
  if (!next) return null;
  const today = startOfUtcDay(now);
  if (next < today) return 'overdue';
  if (next <= addUtcDays(today, dueSoonDays)) return 'due_soon';
  return 'safe';
}

/** Filter Prisma untuk calibration_state (konsisten dengan calibrationState()). */
export function calibrationWhere(
  state: CalibrationState,
  now: Date = new Date(),
  dueSoonDays: number = env.CALIBRATION_DUE_SOON_DAYS,
): Prisma.DateTimeNullableFilter {
  const today = startOfUtcDay(now);
  const limit = addUtcDays(today, dueSoonDays);
  if (state === 'overdue') return { lt: today };
  if (state === 'due_soon') return { gte: today, lte: limit };
  return { gt: limit };
}

/** Sisa umur pakai (tahun, 2 desimal, min 0). null jika purchase_date/useful_life_years kosong. */
export function remainingUsefulLifeYears(
  purchaseDate: Date | null | undefined,
  usefulLifeYears: number | null | undefined,
  now: Date = new Date(),
): number | null {
  if (!purchaseDate || !usefulLifeYears) return null;
  const end = Date.UTC(
    purchaseDate.getUTCFullYear() + usefulLifeYears,
    purchaseDate.getUTCMonth(),
    purchaseDate.getUTCDate(),
  );
  const years = (end - startOfUtcDay(now).getTime()) / (365.2425 * DAY_MS);
  return Math.round(Math.max(years, 0) * 100) / 100;
}

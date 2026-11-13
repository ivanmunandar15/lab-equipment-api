import { addUtcDays } from '../equipment/equipment.derive';

export type CalibrationEmailStage = 'calibration_30d' | 'calibration_7d' | 'calibration_1d' | 'calibration_overdue';

export const DAY_MS = 86_400_000;

/** Selisih hari (tanggal jatuh tempo − hari ini); keduanya tanggal UTC 00:00. */
export const daysUntil = (next: Date, today: Date): number => Math.round((next.getTime() - today.getTime()) / DAY_MS);

/**
 * Tahap pengingat email: tepat 30, 7, 1 hari lagi, serta terlambat (<0).
 * Hari-H (0) dimasukkan ke tahap 1 hari (jika H-1 sudah terkirim, penanda unik mencegah kirim ganda).
 * Selain itu null (tidak ada email).
 */
export function emailStageFor(daysLeft: number): CalibrationEmailStage | null {
  if (daysLeft < 0) return 'calibration_overdue';
  if (daysLeft === 0 || daysLeft === 1) return 'calibration_1d';
  if (daysLeft === 7) return 'calibration_7d';
  if (daysLeft === 30) return 'calibration_30d';
  return null;
}

/** Batas atas pencarian alat di database (H+30). */
export const lookaheadLimit = (today: Date) => addUtcDays(today, 30);

export const STAGE_ORDER: CalibrationEmailStage[] = ['calibration_overdue', 'calibration_1d', 'calibration_7d', 'calibration_30d'];
export const STAGE_LABEL: Record<CalibrationEmailStage, string> = {
  calibration_overdue: 'Terlambat',
  calibration_1d: 'H-1',
  calibration_7d: 'H-7',
  calibration_30d: 'H-30',
};
export const STAGE_COLOR: Record<CalibrationEmailStage, string> = {
  calibration_overdue: '#dc2626',
  calibration_1d: '#ea580c',
  calibration_7d: '#d97706',
  calibration_30d: '#2563eb',
};

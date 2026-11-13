import { getDb } from '../config/db';
import { addUtcDays, dateOnly, startOfUtcDay } from '../modules/equipment/equipment.derive';
import { createNotification } from '../modules/notifications/notify.service';
import type { Role } from '@prisma/client';
import { logger } from '../config/logger';
import { runCalibrationEmailReminders } from '../modules/email/calibration-reminders';

export type CalibrationStage = 'H30' | 'H7' | 'OVERDUE';
const RECIPIENTS: Role[] = ['admin', 'SPV', 'technician'];

export const calibrationStage = (daysLeft: number): CalibrationStage => (daysLeft < 0 ? 'OVERDUE' : daysLeft <= 7 ? 'H7' : 'H30');

/**
 * Notifikasi kalibrasi H-30, H-7, dan terlambat. Tahap ditentukan dari sisa hari (bukan harus tepat H-30/H-7),
 * sehingga tidak terlewat bila job sempat mati. Anti-duplikat: satu notifikasi per alat per tahap per jadwal kalibrasi
 * (dedupe_key memuat next_calibration_date, jadi siklus kalibrasi berikutnya mulai dari awal lagi).
 */
export async function runCalibrationReminders(now: Date = new Date()) {
  const db = getDb();
  const today = startOfUtcDay(now);
  const rows = await db.equipment.findMany({
    where: { is_active: true, next_calibration_date: { lte: addUtcDays(today, 30) } },
    select: { equipment_id: true, inventory_code: true, equipment_name: true, status: true, next_calibration_date: true },
  });

  let created = 0;
  let skipped = 0;
  for (const e of rows) {
    if (!e.next_calibration_date || e.status === 'calibration') continue;
    const daysLeft = Math.round((e.next_calibration_date.getTime() - today.getTime()) / 86_400_000);
    const stage = calibrationStage(daysLeft);
    const key = `cal:${e.equipment_id}:${dateOnly(e.next_calibration_date)}:${stage}`;
    if (await db.notification.findFirst({ where: { dedupe_key: key }, select: { notification_id: true } })) {
      skipped++;
      continue;
    }
    const last = await db.calibration.findFirst({ where: { equipment_id: e.equipment_id }, orderBy: { calibration_date: 'desc' }, select: { calibration_id: true } });
    const label = `${e.inventory_code} — ${e.equipment_name}`;
    const message =
      stage === 'OVERDUE'
        ? `Kalibrasi ${label} terlambat ${Math.abs(daysLeft)} hari (jatuh tempo ${dateOnly(e.next_calibration_date)}).`
        : `Kalibrasi ${label} jatuh tempo ${daysLeft === 0 ? 'hari ini' : `dalam ${daysLeft} hari`} (${dateOnly(e.next_calibration_date)}).`;
    const n = await db.$transaction((tx) =>
      createNotification(tx, {
        roles: RECIPIENTS,
        type: 'calibration',
        title: stage === 'OVERDUE' ? 'Kalibrasi terlambat' : stage === 'H7' ? 'Kalibrasi H-7' : 'Kalibrasi H-30',
        message,
        calibration_id: last?.calibration_id ?? null,
        dedupe_key: key,
      }),
    );
    if (n > 0) created++;
  }
  return { checked: rows.length, created, skipped };
}

/**
 * Job kalibrasi harian: notifikasi di aplikasi (runCalibrationReminders) lalu email digest.
 * Kegagalan email TIDAK menggagalkan job in-app.
 */
export async function runCalibrationJob(now: Date = new Date()) {
  const in_app = await runCalibrationReminders(now);
  let email: unknown;
  try {
    email = await runCalibrationEmailReminders(now);
  } catch (err) {
    logger.error({ err }, 'pengingat email kalibrasi gagal (job in-app tetap selesai)');
    email = { error: 'email reminder gagal' };
  }
  return { in_app, email };
}

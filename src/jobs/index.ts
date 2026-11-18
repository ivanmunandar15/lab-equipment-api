import cron, { type ScheduledTask } from 'node-cron';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { runBorrowingOverdueReminders } from './borrowing-overdue.job';
import { runCalibrationJob } from './calibration.job';
import { DEFAULT_JOB_TIME, timeToCron } from '../modules/email/email-settings.core';
import { loadEmailSettings, onCalibrationJobTimeChange } from '../modules/email/email-settings';
import { recoverQueuedEmails } from '../modules/email/email.service';
import { verifyMailer } from '../modules/email/mailer';
import { runLowStockReminders } from './low-stock.job';
import { schedule, type JobDefinition } from './runner';
import { runWeeklyCleanup } from './weekly-cleanup.job';

const CALIBRATION_JOB = 'calibration-reminders';

/** Daftar job. Jadwal mengikuti JOBS_TIMEZONE. Matikan semua dengan JOBS_ENABLED=false. */
export const JOBS: JobDefinition[] = [
  { name: CALIBRATION_JOB, schedule: '0 7 * * *', description: 'Harian (default 07:00, jam bisa diubah di Pengaturan Email) — notifikasi + email digest kalibrasi (H-30, H-7, H-1, terlambat)', run: () => runCalibrationJob() },
  { name: 'borrowing-overdue', schedule: '0 * * * *', description: 'Tiap jam — notifikasi peminjaman terlambat (maks 1x/hari/peminjaman)', run: () => runBorrowingOverdueReminders() },
  { name: 'low-stock', schedule: '15 7 * * *', description: 'Harian 07:15 — notifikasi stok rendah supporting equipment', run: () => runLowStockReminders() },
  { name: 'weekly-cleanup', schedule: '0 3 * * 0', description: 'Mingguan (Minggu 03:00) — hapus refresh token kedaluwarsa + retensi monitoring', run: () => runWeeklyCleanup() },
];

const tasks = new Map<string, ScheduledTask>();
let calibrationTime = DEFAULT_JOB_TIME;

/** Jadwalkan ulang job kalibrasi harian ke jam baru (HH:mm). Tidak melakukan apa-apa bila jam sama. */
function applyCalibrationTime(time: string): void {
  const job = JOBS.find((j) => j.name === CALIBRATION_JOB);
  if (!job || (time === calibrationTime && tasks.has(CALIBRATION_JOB))) return;
  tasks.get(CALIBRATION_JOB)?.stop();
  tasks.set(CALIBRATION_JOB, schedule({ ...job, schedule: timeToCron(time) }));
  calibrationTime = time;
  logger.info({ time, timezone: env.JOBS_TIMEZONE }, 'jadwal job pengingat kalibrasi diperbarui');
}

export function startJobs() {
  for (const job of JOBS) tasks.set(job.name, schedule(job));

  // Jam job dari Pengaturan Email: langsung berlaku di instance ini; polling tiap 2 menit untuk perubahan dari instance lain.
  onCalibrationJobTimeChange(applyCalibrationTime);
  const sync = () => void loadEmailSettings().then((s) => applyCalibrationTime(s.calibration_job_time)).catch(() => undefined);
  sync();
  tasks.set('settings-sync', cron.schedule('*/2 * * * *', sync, { timezone: env.JOBS_TIMEZONE }));

  void verifyMailer().then(() => recoverQueuedEmails());
  logger.info({ timezone: env.JOBS_TIMEZONE, jobs: JOBS.map((j) => `${j.name} [${j.schedule}]`) }, 'cron jobs aktif');
}

export function stopJobs() {
  for (const t of tasks.values()) t.stop();
  tasks.clear();
  calibrationTime = DEFAULT_JOB_TIME;
  onCalibrationJobTimeChange(null);
}

import type { ScheduledTask } from 'node-cron';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { runBorrowingOverdueReminders } from './borrowing-overdue.job';
import { runCalibrationJob } from './calibration.job';
import { recoverQueuedEmails } from '../modules/email/email.service';
import { verifyMailer } from '../modules/email/mailer';
import { runLowStockReminders } from './low-stock.job';
import { schedule, type JobDefinition } from './runner';
import { runWeeklyCleanup } from './weekly-cleanup.job';

/** Daftar job. Jadwal mengikuti JOBS_TIMEZONE. Matikan semua dengan JOBS_ENABLED=false. */
export const JOBS: JobDefinition[] = [
  { name: 'calibration-reminders', schedule: '0 7 * * *', description: 'Harian 07:00 — notifikasi + email digest kalibrasi (H-30, H-7, H-1, terlambat)', run: () => runCalibrationJob() },
  { name: 'borrowing-overdue', schedule: '0 * * * *', description: 'Tiap jam — notifikasi peminjaman terlambat (maks 1x/hari/peminjaman)', run: () => runBorrowingOverdueReminders() },
  { name: 'low-stock', schedule: '15 7 * * *', description: 'Harian 07:15 — notifikasi stok rendah supporting equipment', run: () => runLowStockReminders() },
  { name: 'weekly-cleanup', schedule: '0 3 * * 0', description: 'Mingguan (Minggu 03:00) — hapus refresh token kedaluwarsa + retensi monitoring', run: () => runWeeklyCleanup() },
];

const tasks: ScheduledTask[] = [];

export function startJobs() {
  for (const job of JOBS) tasks.push(schedule(job));
  void verifyMailer().then(() => recoverQueuedEmails());
  logger.info({ timezone: env.JOBS_TIMEZONE, jobs: JOBS.map((j) => `${j.name} [${j.schedule}]`) }, 'cron jobs aktif');
}

export function stopJobs() {
  for (const t of tasks) t.stop();
  tasks.length = 0;
}

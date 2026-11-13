import cron, { type ScheduledTask } from 'node-cron';
import { env } from '../config/env';
import { logger } from '../config/logger';

export interface JobDefinition {
  name: string;
  /** Ekspresi cron (zona waktu = JOBS_TIMEZONE). */
  schedule: string;
  description: string;
  run: () => Promise<unknown>;
}

const running = new Set<string>();

/** Jalankan job dengan guard anti-tumpang-tindih (in-process) dan log hasil/error. Tidak pernah melempar. */
export async function runJob(job: Pick<JobDefinition, 'name' | 'run'>): Promise<unknown> {
  if (running.has(job.name)) {
    logger.warn({ job: job.name }, 'job masih berjalan, eksekusi dilewati');
    return null;
  }
  running.add(job.name);
  const started = Date.now();
  try {
    const result = await job.run();
    logger.info({ job: job.name, ms: Date.now() - started, result }, 'job selesai');
    return result;
  } catch (err) {
    logger.error({ err, job: job.name }, 'job gagal');
    return null;
  } finally {
    running.delete(job.name);
  }
}

export function schedule(job: JobDefinition): ScheduledTask {
  return cron.schedule(job.schedule, () => void runJob(job), { timezone: env.JOBS_TIMEZONE });
}

/** Tanggal lokal (YYYY-MM-DD) pada JOBS_TIMEZONE; dipakai untuk kunci "sekali per hari". */
export function localDayKey(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: env.JOBS_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

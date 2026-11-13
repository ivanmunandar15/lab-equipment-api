import { Prisma } from '@prisma/client';
import { env } from '../config/env';
import { getDb } from '../config/db';
import { logger } from '../config/logger';

const BATCH = 10_000;
const MAX_BATCHES = 500; // pengaman: maks 5 juta baris per eksekusi
let running = false;

/**
 * Hapus data mentah room_monitoring yang lebih tua dari MONITORING_RETENTION_DAYS.
 * Dihapus per batch agar tidak mengunci tabel lama. Aman dijalankan ulang / paralel (guard in-process).
 */
export async function runMonitoringRetention(now = new Date()): Promise<{ deleted: number; cutoff: string } | null> {
  if (running) return null;
  running = true;
  try {
    const cutoff = new Date(now.getTime() - env.MONITORING_RETENTION_DAYS * 86_400_000);
    const iso = cutoff.toISOString();
    const db = getDb();
    let deleted = 0;
    for (let i = 0; i < MAX_BATCHES; i++) {
      const n = await db.$executeRaw(Prisma.sql`
        DELETE FROM room_monitoring
        WHERE monitoring_id IN (
          SELECT monitoring_id FROM room_monitoring WHERE measurement_time < ${iso}::timestamp LIMIT ${BATCH}
        )`);
      deleted += n;
      if (n < BATCH) break;
    }
    logger.info({ deleted, cutoff: iso, retention_days: env.MONITORING_RETENTION_DAYS }, 'job retensi monitoring selesai');
    return { deleted, cutoff: iso };
  } catch (err) {
    logger.error({ err }, 'job retensi monitoring gagal');
    return null;
  } finally {
    running = false;
  }
}

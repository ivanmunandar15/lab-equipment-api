import { getDb } from '../config/db';
import { runMonitoringRetention } from './retention.job';

/**
 * Mingguan: (1) hapus refresh token yang sudah kedaluwarsa — token yang dicabut tetapi belum kedaluwarsa
 * sengaja dipertahankan agar deteksi pemakaian ulang token tetap bekerja; (2) retensi data monitoring.
 */
export async function runWeeklyCleanup(now: Date = new Date()) {
  const tokens = await getDb().refreshToken.deleteMany({ where: { expires_at: { lt: now } } });
  const monitoring = await runMonitoringRetention(now);
  return { expired_refresh_tokens_deleted: tokens.count, monitoring };
}

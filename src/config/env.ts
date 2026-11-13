import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL wajib diisi'),
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET minimal 32 karakter'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET minimal 32 karakter'),
  JWT_ACCESS_EXPIRES_IN: z.string().regex(/^\d+[smhd]$/, 'Format durasi: 15m, 7d, dst').default('15m'),
  JWT_REFRESH_EXPIRES_IN: z.string().regex(/^\d+[smhd]$/, 'Format durasi: 15m, 7d, dst').default('7d'),
  COOKIE_SAME_SITE: z.enum(['lax', 'strict', 'none']).default('lax'),
  CORS_ORIGIN: z.string().min(1, 'CORS_ORIGIN wajib diisi'),
  APP_URL: z.string().url('APP_URL harus berupa URL valid'),
  UPLOAD_DIR: z.string().min(1).default('./uploads'),
  /** Batas ukuran file sertifikat kalibrasi (MB). */
  CERTIFICATE_MAX_MB: z.coerce.number().min(1).max(20).default(5),
  /** block = tolak jika melebihi kapasitas ruangan; warn = izinkan dan kembalikan peringatan. */
  ROOM_CAPACITY_MODE: z.enum(['block', 'warn']).default('block'),
  /** Batas hari untuk calibration_state = due_soon. */
  CALIBRATION_DUE_SOON_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  /** Alat dengan kalibrasi terlambat: block = tolak peminjaman (default, sama dengan frontend); warn = boleh dipinjam + peringatan `calibration_overdue`. */
  CALIBRATION_OVERDUE_POLICY: z.enum(['warn', 'block']).default('block'),
  /** Data mentah monitoring lebih lama dari N hari dihapus oleh job retensi. */
  MONITORING_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(90),
  /** Jeda minimal antar notifikasi di-luar-batas untuk sensor yang sama (menit). */
  MONITORING_ALERT_COOLDOWN_MINUTES: z.coerce.number().int().min(1).max(1440).default(30),
  /** Batas ukuran dokumen alat (MB). */
  DOCUMENT_MAX_MB: z.coerce.number().min(1).max(50).default(10),
  /** Stok supporting equipment dianggap rendah jika available_quantity <= nilai ini (dan total_quantity > 0). */
  LOW_STOCK_THRESHOLD: z.coerce.number().int().min(0).max(100000).default(2),
  /** Cache singkat endpoint dashboard (detik). 0 = nonaktif. */
  DASHBOARD_CACHE_SECONDS: z.coerce.number().int().min(0).max(600).default(30),
  /** Zona waktu jadwal cron (IANA), mis. Asia/Jakarta. */
  JOBS_TIMEZONE: z.string().min(1).default('Asia/Jakarta'),
  /** false = job cron tidak dijalankan (mis. instance API tambahan). */
  JOBS_ENABLED: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  /** Email pengingat (Tahap 11). EMAIL_ENABLED=false: email tidak dikirim, isinya hanya dicatat ke log. */
  EMAIL_ENABLED: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  SMTP_HOST: z.string().min(1).default('localhost'),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(1025),
  SMTP_SECURE: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  MAIL_FROM: z.string().min(3).default('Lab Equipment <no-reply@lab.local>'),
  FRONTEND_URL: z.string().url('FRONTEND_URL harus berupa URL valid').default('http://localhost:3001'),
  /** Pengingat kalibrasi terlambat diulang tiap N hari sampai kalibrasi dicatat. */
  OVERDUE_REMINDER_REPEAT_DAYS: z.coerce.number().int().min(1).max(30).default(3),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  // Gagal cepat saat startup
  console.error('❌ Konfigurasi environment tidak valid:');
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
export const corsOrigins = env.CORS_ORIGIN.split(',').map((s) => s.trim());

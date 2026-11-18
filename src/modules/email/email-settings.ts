import type { Prisma } from '@prisma/client';
import { getDb } from '../../config/db';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import {
  DEFAULT_JOB_TIME,
  SETTINGS_KEY_EMAIL,
  SETTING_FIELDS,
  encryptSecret,
  mergeSettings,
  toPublic,
  type EmailSettings,
  type EmailSettingsFull,
  type StoredEmailSettings,
} from './email-settings.core';

export type { EmailSettings, EmailSettingsFull } from './email-settings.core';

/**
 * Pengaturan email yang bisa diubah dari frontend (disimpan di tabel app_settings, key "email").
 * Nilai yang belum pernah diubah memakai default dari .env, jadi instalasi lama tetap berjalan tanpa perubahan.
 * Dibaca ulang dari DB paling lambat tiap CACHE_MS, jadi perubahan berlaku tanpa restart (juga di instance lain).
 */

const CACHE_MS = 5_000;

interface Cached {
  stored: StoredEmailSettings | null;
  updated_at: Date | null;
  at: number;
}
let cache: Cached | null = null;
let lastWarn = 0;

const secret = (): string => env.SETTINGS_ENCRYPTION_KEY ?? env.JWT_REFRESH_SECRET;

/** Nilai default dari .env (dibaca saat dipanggil, bukan saat modul dimuat). */
export function envDefaults(): EmailSettingsFull {
  return {
    email_enabled: env.EMAIL_ENABLED,
    calibration_email_mode: env.CALIBRATION_EMAIL_MODE,
    overdue_repeat_days: env.OVERDUE_REMINDER_REPEAT_DAYS,
    calibration_job_time: DEFAULT_JOB_TIME,
    smtp_host: env.SMTP_HOST,
    smtp_port: env.SMTP_PORT,
    smtp_secure: env.SMTP_SECURE,
    smtp_user: env.SMTP_USER ?? '',
    smtp_pass: env.SMTP_PASS ?? '',
    mail_from: env.MAIL_FROM,
    frontend_url: env.FRONTEND_URL,
  };
}

async function readStored(force = false): Promise<Cached> {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache;
  try {
    const row = await getDb().appSetting.findUnique({ where: { key: SETTINGS_KEY_EMAIL } });
    cache = { stored: row ? (row.value as unknown as StoredEmailSettings) : null, updated_at: row?.updated_at ?? null, at: Date.now() };
    return cache;
  } catch (err) {
    // DB belum siap / tabel belum dimigrasi: pakai default .env, jangan menggagalkan pengiriman email.
    if (Date.now() - lastWarn > 60_000) {
      lastWarn = Date.now();
      logger.warn({ err }, 'gagal membaca pengaturan email dari database, memakai default .env');
    }
    return { stored: null, updated_at: null, at: 0 };
  }
}

/** Pengaturan efektif saat ini (default .env + yang disimpan). Tidak pernah melempar. */
export async function loadEmailSettings(): Promise<EmailSettingsFull> {
  const { stored } = await readStored();
  return mergeSettings(envDefaults(), stored, secret());
}

/** Versi sinkron dari cache terakhir (untuk render template). Jika belum pernah dimuat = default .env. */
export function currentEmailSettings(): EmailSettingsFull {
  return mergeSettings(envDefaults(), cache?.stored ?? null, secret());
}

export function resetEmailSettingsCache(): void {
  cache = null;
}

export interface EmailSettingsView extends EmailSettings {
  smtp_pass_set: boolean;
  /** true = belum pernah diubah dari frontend; semua nilai berasal dari .env. */
  using_defaults: boolean;
  updated_at: string | null;
}

export async function getEmailSettingsView(): Promise<EmailSettingsView> {
  const c = await readStored(true);
  return {
    ...toPublic(mergeSettings(envDefaults(), c.stored, secret())),
    using_defaults: !c.stored,
    updated_at: c.updated_at ? c.updated_at.toISOString() : null,
  };
}

export type UpdateEmailSettingsInput = Partial<EmailSettings> & { smtp_pass?: string; clear_smtp_pass?: boolean };

/** Callback saat jam job kalibrasi berubah (dipasang oleh jobs/index.ts). */
let jobTimeListener: ((time: string) => void) | null = null;
export function onCalibrationJobTimeChange(cb: ((time: string) => void) | null): void {
  jobTimeListener = cb;
}

export async function updateEmailSettings(patch: UpdateEmailSettingsInput, userId: string | null): Promise<EmailSettingsView> {
  const db = getDb();
  const before = await loadEmailSettings();
  const row = await db.appSetting.findUnique({ where: { key: SETTINGS_KEY_EMAIL } });
  const next: StoredEmailSettings = { ...((row?.value ?? {}) as unknown as StoredEmailSettings) };
  for (const f of SETTING_FIELDS) {
    if (patch[f] !== undefined) (next as Record<string, unknown>)[f] = patch[f];
  }
  if (patch.clear_smtp_pass) delete next.smtp_pass_enc;
  else if (patch.smtp_pass) next.smtp_pass_enc = encryptSecret(patch.smtp_pass, secret());

  const value = next as unknown as Prisma.InputJsonValue;
  await db.appSetting.upsert({
    where: { key: SETTINGS_KEY_EMAIL },
    create: { key: SETTINGS_KEY_EMAIL, value, updated_by: userId },
    update: { value, updated_by: userId },
  });
  resetEmailSettingsCache();
  const after = await loadEmailSettings();
  if (after.calibration_job_time !== before.calibration_job_time) jobTimeListener?.(after.calibration_job_time);
  return getEmailSettingsView();
}

/** Hapus semua pengaturan tersimpan: kembali memakai nilai dari .env. */
export async function resetEmailSettings(): Promise<EmailSettingsView> {
  const before = await loadEmailSettings();
  await getDb().appSetting.deleteMany({ where: { key: SETTINGS_KEY_EMAIL } });
  resetEmailSettingsCache();
  const after = await loadEmailSettings();
  if (after.calibration_job_time !== before.calibration_job_time) jobTimeListener?.(after.calibration_job_time);
  return getEmailSettingsView();
}

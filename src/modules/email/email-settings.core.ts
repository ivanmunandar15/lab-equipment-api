import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

/**
 * Logika murni pengaturan email (tanpa akses DB/env) agar mudah diuji.
 * Pengaturan efektif = default dari .env, ditimpa nilai yang disimpan dari halaman Pengaturan Email.
 */

export type CalibrationEmailMode = 'auto' | 'manual';

export interface EmailSettings {
  email_enabled: boolean;
  calibration_email_mode: CalibrationEmailMode;
  overdue_repeat_days: number;
  /** Jam job pengingat kalibrasi harian, format HH:mm (zona waktu JOBS_TIMEZONE). */
  calibration_job_time: string;
  smtp_host: string;
  smtp_port: number;
  smtp_secure: boolean;
  smtp_user: string;
  mail_from: string;
  frontend_url: string;
}

/** Pengaturan efektif untuk dipakai server (termasuk password SMTP, tidak pernah dikirim ke klien). */
export type EmailSettingsFull = EmailSettings & { smtp_pass: string };

/** Bentuk yang disimpan di app_settings: hanya field yang diubah + password terenkripsi. */
export type StoredEmailSettings = Partial<EmailSettings> & { smtp_pass_enc?: string };

export const SETTINGS_KEY_EMAIL = 'email';
export const DEFAULT_JOB_TIME = '07:00';
export const JOB_TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const SETTING_FIELDS = [
  'email_enabled',
  'calibration_email_mode',
  'overdue_repeat_days',
  'calibration_job_time',
  'smtp_host',
  'smtp_port',
  'smtp_secure',
  'smtp_user',
  'mail_from',
  'frontend_url',
] as const satisfies readonly (keyof EmailSettings)[];

/** "07:30" → "30 7 * * *". Nilai tidak valid jatuh ke default 07:00. */
export function timeToCron(time: string): string {
  const m = JOB_TIME_RE.exec(time) ?? JOB_TIME_RE.exec(DEFAULT_JOB_TIME)!;
  return `${Number(m[2])} ${Number(m[1])} * * *`;
}

const keyFrom = (secret: string): Buffer => createHash('sha256').update(`lab-email-settings:v1:${secret}`).digest();

/** AES-256-GCM. Format: v1:<iv>:<tag>:<ciphertext> (base64). */
export function encryptSecret(plain: string, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFrom(secret), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), enc.toString('base64')].join(':');
}

/** null jika format salah atau kunci berbeda (mis. JWT secret diganti). */
export function decryptSecret(token: string, secret: string): string | null {
  try {
    const [v, iv, tag, enc] = token.split(':');
    if (v !== 'v1' || !iv || !tag || enc === undefined) return null;
    const decipher = createDecipheriv('aes-256-gcm', keyFrom(secret), Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(enc, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** Gabungkan default (.env) dengan nilai tersimpan. Field yang tidak tersimpan memakai default. */
export function mergeSettings(defaults: EmailSettingsFull, stored: StoredEmailSettings | null, secret: string): EmailSettingsFull {
  const out: EmailSettingsFull = { ...defaults };
  if (!stored) return out;
  for (const f of SETTING_FIELDS) {
    const v = stored[f];
    if (v !== undefined && v !== null) (out as unknown as Record<string, unknown>)[f] = v;
  }
  if (stored.smtp_pass_enc) {
    const pass = decryptSecret(stored.smtp_pass_enc, secret);
    if (pass !== null) out.smtp_pass = pass;
  }
  return out;
}

/** Salinan aman untuk klien: tanpa password, hanya penanda apakah password sudah diisi. */
export function toPublic(full: EmailSettingsFull): EmailSettings & { smtp_pass_set: boolean } {
  const { smtp_pass, ...rest } = full;
  return { ...rest, smtp_pass_set: smtp_pass.length > 0 };
}

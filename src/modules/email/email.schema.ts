import { z } from 'zod';
import { paginationQuerySchema } from '../../utils/pagination';

export const idParams = z.object({ id: z.string().uuid('ID tidak valid') });

const isoDate = z.string().trim().refine((s) => !Number.isNaN(Date.parse(s)), 'Format tanggal tidak valid (ISO 8601)');
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export const emailPreferencesBody = z.object({ email_notifications: z.boolean() }).strict();

export const listEmailLogsQuery = paginationQuerySchema
  .extend({
    status: z.enum(['queued', 'sent', 'failed']).optional(),
    reminder_type: z.enum(['calibration_30d', 'calibration_7d', 'calibration_1d', 'calibration_overdue', 'borrowing_overdue', 'digest']).optional(),
    user_id: z.string().uuid('user_id tidak valid').optional(),
    date_from: isoDate.transform((s) => new Date(s)).optional(),
    date_to: isoDate.transform((s) => (DATE_ONLY.test(s) ? new Date(`${s}T23:59:59.999Z`) : new Date(s))).optional(),
    /** true = sertakan penanda per-alat (anak dari email digest). */
    include_markers: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  })
  .refine((v) => !v.date_from || !v.date_to || v.date_from <= v.date_to, { message: 'date_from tidak boleh setelah date_to', path: ['date_from'] });
export type ListEmailLogsQuery = z.infer<typeof listEmailLogsQuery>;

/** Penerima yang dipilih admin untuk pengiriman manual (user_id dari pratinjau). */
export const sendRemindersBody = z.object({
  user_ids: z.array(z.string().uuid()).min(1, 'Pilih minimal satu penerima').max(200).transform((ids) => [...new Set(ids)]),
});
export type SendRemindersBody = z.infer<typeof sendRemindersBody>;

export const runJobQuery = z.object({
  dry_run: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
});

/**
 * Pengaturan email dari halaman admin. Semua field opsional (PATCH parsial).
 * smtp_pass: kosong/tidak dikirim = password lama tidak diubah; clear_smtp_pass=true = hapus password tersimpan.
 */
export const updateEmailSettingsBody = z
  .object({
    email_enabled: z.boolean(),
    calibration_email_mode: z.enum(['auto', 'manual']),
    overdue_repeat_days: z.number().int().min(1, 'Minimal 1 hari').max(30, 'Maksimal 30 hari'),
    calibration_job_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Format jam HH:mm, mis. 07:00'),
    smtp_host: z.string().trim().min(1, 'Host SMTP wajib diisi').max(255),
    smtp_port: z.number().int().min(1).max(65535),
    smtp_secure: z.boolean(),
    smtp_user: z.string().trim().max(255),
    smtp_pass: z.string().max(500),
    clear_smtp_pass: z.boolean(),
    mail_from: z.string().trim().min(3, 'Pengirim minimal 3 karakter').max(255),
    frontend_url: z.string().trim().url('URL frontend tidak valid').max(500),
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Tidak ada perubahan yang dikirim' });
export type UpdateEmailSettingsBody = z.infer<typeof updateEmailSettingsBody>;

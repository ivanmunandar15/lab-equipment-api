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

export const runJobQuery = z.object({
  dry_run: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
});

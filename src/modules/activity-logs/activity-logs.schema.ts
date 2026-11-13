import { z } from 'zod';
import { paginationQuerySchema } from '../../utils/pagination';

export const idParams = z.object({ id: z.string().uuid('ID tidak valid') });

const isoDate = z.string().trim().refine((s) => !Number.isNaN(Date.parse(s)), 'Format tanggal tidak valid (ISO 8601)');
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export const listActivityLogsQuery = paginationQuerySchema
  .extend({
    user_id: z.string().uuid('user_id tidak valid').optional(),
    action: z.string().trim().min(1).max(50).transform((s) => s.toUpperCase()).optional(),
    entity_type: z.string().trim().min(1).max(50).transform((s) => s.toLowerCase()).optional(),
    entity_id: z.string().trim().min(1).max(100).optional(),
    date_from: isoDate.transform((s) => new Date(s)).optional(),
    // `YYYY-MM-DD` dianggap sampai akhir hari (UTC)
    date_to: isoDate
      .transform((s) => (DATE_ONLY.test(s) ? new Date(`${s}T23:59:59.999Z`) : new Date(s)))
      .optional(),
  })
  .refine((v) => !v.date_from || !v.date_to || v.date_from <= v.date_to, {
    message: 'date_from tidak boleh setelah date_to',
    path: ['date_from'],
  });

export type ListActivityLogsQuery = z.infer<typeof listActivityLogsQuery>;

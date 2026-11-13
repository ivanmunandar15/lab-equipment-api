import { z } from 'zod';
import { paginationQuerySchema } from '../../utils/pagination';
import { dateOnlySchema, idParams, optText, priceSchema } from '../equipment/equipment.schema';

export { idParams };

const uuid = (n: string) => z.string().uuid(`${n} tidak valid`);
const TYPES = ['routine', 'repair'] as const;
export const MAINTENANCE_STATUSES = ['scheduled', 'in_progress', 'completed', 'cancelled'] as const;

/** ISO 8601 (dengan zona waktu) atau YYYY-MM-DD (dianggap 00:00 UTC) → Date. */
export const dateTimeSchema = z
  .string()
  .trim()
  .refine((s) => /^\d{4}-\d{2}-\d{2}$/.test(s) || !Number.isNaN(Date.parse(s)), 'Format harus ISO 8601 atau YYYY-MM-DD')
  .refine((s) => /^\d{4}-\d{2}-\d{2}$/.test(s) || /(Z|[+-]\d{2}:?\d{2})$/.test(s), 'Sertakan zona waktu, mis. 2026-11-02T09:00:00Z')
  .transform((s) => new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00.000Z` : s))
  .refine((d) => !Number.isNaN(d.getTime()), 'Tanggal tidak valid');

export const createMaintenanceBody = z.object({
  equipment_id: uuid('equipment_id'),
  /** Default: user yang login. */
  technician_id: uuid('technician_id').optional(),
  maintenance_type: z.enum(TYPES),
  maintenance_date: dateTimeSchema,
  description: optText(2000),
  cost: priceSchema.nullable().optional(),
  replaced_spare_parts: optText(1000),
  notes: optText(2000),
});

// equipment_id tidak bisa diubah setelah dibuat.
export const updateMaintenanceBody = z
  .object({
    technician_id: uuid('technician_id'),
    maintenance_type: z.enum(TYPES),
    maintenance_date: dateTimeSchema,
    description: optText(2000),
    cost: priceSchema.nullable(),
    replaced_spare_parts: optText(1000),
    notes: optText(2000),
    status: z.enum(MAINTENANCE_STATUSES),
    /** Hanya saat status → completed. Default: sekarang. */
    completion_date: dateTimeSchema,
    /** Hanya saat status → completed: true = alat berstatus damaged, bukan available. */
    equipment_damaged: z.boolean(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Minimal satu field harus diisi' });

const dateRange = (v: { date_from?: Date; date_to?: Date }) => !v.date_from || !v.date_to || v.date_from <= v.date_to;

export const listMaintenancesQuery = paginationQuerySchema
  .extend({
    maintenance_type: z.enum(TYPES).optional(),
    status: z.enum(MAINTENANCE_STATUSES).optional(),
    equipment_id: uuid('equipment_id').optional(),
    technician_id: uuid('technician_id').optional(),
    date_from: dateOnlySchema.optional(),
    date_to: dateOnlySchema.optional(),
  })
  .refine(dateRange, { message: 'date_from tidak boleh setelah date_to', path: ['date_from'] });

export type CreateMaintenanceBody = z.infer<typeof createMaintenanceBody>;
export type UpdateMaintenanceBody = z.infer<typeof updateMaintenanceBody>;
export type ListMaintenancesQuery = z.infer<typeof listMaintenancesQuery>;

import { z } from 'zod';
import { paginationQuerySchema } from '../../utils/pagination';
import { CALIBRATION_STATES, dateOnlySchema, idParams, optText, priceSchema } from '../equipment/equipment.schema';
import { startOfUtcDay } from '../equipment/equipment.derive';

export { idParams };

const uuid = (n: string) => z.string().uuid(`${n} tidak valid`);

export const createCalibrationBody = z
  .object({
    equipment_id: uuid('equipment_id'),
    calibration_date: dateOnlySchema,
    next_calibration_date: dateOnlySchema,
    calibration_provider: optText(150),
    certificate_number: optText(100),
    calibration_result: z.enum(['passed', 'failed']),
    /** Hanya dipakai bila failed: status alat sesudahnya. Default `calibration`. Diabaikan bila passed. */
    status_after_fail: z.enum(['calibration', 'damaged']).optional(),
    cost: priceSchema.nullable().optional(),
    notes: optText(2000),
  })
  .superRefine((v, ctx) => {
    if (v.calibration_date > startOfUtcDay()) {
      ctx.addIssue({ code: 'custom', path: ['calibration_date'], message: 'tidak boleh di masa depan' });
    }
    if (v.next_calibration_date <= v.calibration_date) {
      ctx.addIssue({ code: 'custom', path: ['next_calibration_date'], message: 'harus setelah calibration_date' });
    }
  });

const dateRange = (v: { date_from?: Date; date_to?: Date }) => !v.date_from || !v.date_to || v.date_from <= v.date_to;
const dateRangeMsg = { message: 'date_from tidak boleh setelah date_to', path: ['date_from'] };

export const listCalibrationsQuery = paginationQuerySchema
  .extend({
    equipment_id: uuid('equipment_id').optional(),
    result: z.enum(['passed', 'failed']).optional(),
    state: z.enum(CALIBRATION_STATES).optional(),
    date_from: dateOnlySchema.optional(),
    date_to: dateOnlySchema.optional(),
  })
  .refine(dateRange, dateRangeMsg);

export const scheduleQuery = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Format month harus YYYY-MM'),
  room_id: uuid('room_id').optional(),
});

export const summaryQuery = z.object({ room_id: uuid('room_id').optional() });

export type CreateCalibrationBody = z.infer<typeof createCalibrationBody>;
export type ListCalibrationsQuery = z.infer<typeof listCalibrationsQuery>;

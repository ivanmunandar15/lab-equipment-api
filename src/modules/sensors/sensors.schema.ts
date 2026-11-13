import { z } from 'zod';
import { paginationQuerySchema } from '../../utils/pagination';

const boolQuery = z.enum(['true', 'false']).transform((v) => v === 'true');
const optText = (max: number) =>
  z.string().trim().max(max).transform((v) => (v === '' ? null : v)).nullable().optional();

export const idParams = z.object({ id: z.string().uuid('ID tidak valid') });

const SENSOR_TYPES = ['temperature', 'humidity'] as const;
const SENSOR_STATUSES = ['active', 'inactive', 'damaged'] as const;
const threshold = z.number().finite().min(-9999).max(9999);

export const listSensorsQuery = paginationQuerySchema.extend({
  room_id: z.string().uuid().optional(),
  sensor_type: z.enum(SENSOR_TYPES).optional(),
  sensor_status: z.enum(SENSOR_STATUSES).optional(),
  is_active: boolQuery.optional(),
});

const base = z.object({
  room_id: z.string().uuid('room_id tidak valid'),
  sensor_code: z
    .string()
    .trim()
    .min(1, 'wajib diisi')
    .max(50)
    .regex(/^[A-Za-z0-9._-]+$/, 'Hanya huruf, angka, titik, garis bawah, dan strip'),
  sensor_type: z.enum(SENSOR_TYPES),
  unit: z.string().trim().min(1).max(20).optional(),
  sensor_location: optText(150),
  sensor_status: z.enum(SENSOR_STATUSES).default('active'),
  min_threshold: threshold,
  max_threshold: threshold,
});

const minLtMax = (v: { min_threshold?: number; max_threshold?: number }) =>
  v.min_threshold === undefined || v.max_threshold === undefined || v.min_threshold < v.max_threshold;
const minLtMaxMsg = { message: 'min_threshold harus lebih kecil dari max_threshold', path: ['min_threshold'] };

export const createSensorBody = base
  .extend({ generate_api_key: z.boolean().default(false) })
  .refine(minLtMax, minLtMaxMsg);

export const updateSensorBody = base
  .partial()
  .extend({ is_active: z.boolean().optional() })
  .refine((v) => Object.keys(v).length > 0, { message: 'Minimal satu field harus diisi' })
  .refine(minLtMax, minLtMaxMsg);

export const DEFAULT_UNIT: Record<(typeof SENSOR_TYPES)[number], string> = { temperature: '°C', humidity: '%' };

export type ListSensorsQuery = z.infer<typeof listSensorsQuery>;
export type CreateSensorBody = z.infer<typeof createSensorBody>;
export type UpdateSensorBody = z.infer<typeof updateSensorBody>;

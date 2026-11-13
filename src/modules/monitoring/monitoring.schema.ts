import { z } from 'zod';
import { MAX_BATCH } from './monitoring.logic';

export const idParams = z.object({ id: z.string().uuid('ID tidak valid') });

const reading = z.object({
  /** Opsional; jika diisi harus sama dengan sensor milik X-Sensor-Key. */
  sensor_code: z.string().trim().min(1).max(50).optional(),
  value: z.number().finite().min(-100000).max(100000),
  /** ISO 8601 (disarankan UTC). Default: waktu server. */
  measurement_time: z
    .string()
    .datetime({ offset: true, message: 'measurement_time harus ISO 8601' })
    .transform((s) => new Date(s))
    .optional(),
});

/** Satu objek, array, atau { readings: [...] } → selalu menjadi array. */
export const ingestBody = z
  .union([z.array(reading).min(1).max(MAX_BATCH), z.object({ readings: z.array(reading).min(1).max(MAX_BATCH) }), reading])
  .transform((v) => (Array.isArray(v) ? v : 'readings' in v ? v.readings : [v]));

export type IngestItem = z.infer<typeof reading>;

export const readingsQuery = z
  .object({
    from: z.string().datetime({ offset: true }).transform((s) => new Date(s)).optional(),
    to: z.string().datetime({ offset: true }).transform((s) => new Date(s)).optional(),
    interval: z.enum(['raw', '5m', '1h', '1d']).default('5m'),
  })
  .refine((v) => !v.from || !v.to || v.from < v.to, { message: 'from harus sebelum to', path: ['from'] });

export const streamQuery = z.object({
  room_id: z.string().uuid().optional(),
  sensor_id: z.string().uuid().optional(),
});

export type ReadingsQuery = z.infer<typeof readingsQuery>;
export type StreamQuery = z.infer<typeof streamQuery>;

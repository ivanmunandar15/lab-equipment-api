import { z } from 'zod';
import { paginationQuerySchema } from '../../utils/pagination';

const boolQuery = z.enum(['true', 'false']).transform((v) => v === 'true');
const optText = (max: number) =>
  z.string().trim().max(max).transform((v) => (v === '' ? null : v)).nullable().optional();

export const idParams = z.object({ id: z.string().uuid('ID tidak valid') });

export const listRoomsQuery = paginationQuerySchema.extend({
  is_active: boolQuery.optional(),
  person_in_charge: z.string().uuid('person_in_charge tidak valid').optional(),
});

export const createRoomBody = z.object({
  room_code: z.string().trim().min(1, 'wajib diisi').max(30),
  room_name: z.string().trim().min(2).max(150),
  /** 0 = tidak dibatasi */
  equipment_capacity: z.number().int().min(0).max(100000).default(0),
  person_in_charge: z.string().uuid().nullable().optional(),
  description: optText(1000),
});

export const updateRoomBody = createRoomBody
  .partial()
  .extend({ is_active: z.boolean().optional() })
  .refine((v) => Object.keys(v).length > 0, { message: 'Minimal satu field harus diisi' });

export type ListRoomsQuery = z.infer<typeof listRoomsQuery>;
export type CreateRoomBody = z.infer<typeof createRoomBody>;
export type UpdateRoomBody = z.infer<typeof updateRoomBody>;

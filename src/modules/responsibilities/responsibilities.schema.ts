import { z } from 'zod';

export const idParams = z.object({ id: z.string().uuid('ID tidak valid') });

export const createResponsibilityBody = z
  .object({
    user_id: z.string().uuid('user_id tidak valid'),
    /** Awalan kode inventaris, mis. "INV L-ACT 10". Kosong/null = tidak dipakai sebagai kriteria. */
    code_prefix: z.string().trim().max(50, 'maksimal 50 karakter').transform((v) => (v === '' ? null : v)).nullable().optional(),
    room_id: z.string().uuid('room_id tidak valid').nullable().optional(),
  })
  .strict()
  .refine((v) => !!v.code_prefix || !!v.room_id, { message: 'Isi awalan kode inventaris dan/atau ruangan', path: ['code_prefix'] });
export type CreateResponsibilityBody = z.infer<typeof createResponsibilityBody>;

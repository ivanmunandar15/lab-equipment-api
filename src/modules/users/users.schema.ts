import { z } from 'zod';
import { paginationQuerySchema } from '../../utils/pagination';
import { passwordSchema } from '../../utils/password';

export const roleSchema = z.enum(['QA', 'admin', 'technician', 'SPV']);
const boolQuery = z.enum(['true', 'false']).transform((v) => v === 'true');

export const idParams = z.object({ id: z.string().uuid('ID tidak valid') });

export const listUsersQuery = paginationQuerySchema.extend({
  role: roleSchema.optional(),
  is_active: boolQuery.optional(),
});

export const createUserBody = z.object({
  name: z.string().trim().min(2).max(100),
  email: z.string().trim().toLowerCase().email('Email tidak valid'),
  role: roleSchema,
  /** Jika kosong, server membuat password sementara dan mengembalikannya satu kali. */
  password: passwordSchema.optional(),
});

export const updateUserBody = z
  .object({
    name: z.string().trim().min(2).max(100).optional(),
    role: roleSchema.optional(),
    is_active: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Minimal satu field harus diisi' });

export const resetPasswordBody = z.object({ new_password: passwordSchema.optional() });

export type ListUsersQuery = z.infer<typeof listUsersQuery>;
export type CreateUserBody = z.infer<typeof createUserBody>;
export type UpdateUserBody = z.infer<typeof updateUserBody>;

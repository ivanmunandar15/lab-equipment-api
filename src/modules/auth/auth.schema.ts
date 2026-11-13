import { z } from 'zod';
import { passwordSchema } from '../../utils/password';

export const loginBody = z.object({
  email: z.string().trim().toLowerCase().email('Email tidak valid'),
  password: z.string().min(1, 'Password wajib diisi').max(200),
});

export const updateMeBody = z.object({ name: z.string().trim().min(2).max(100) });

export const changePasswordBody = z
  .object({ current_password: z.string().min(1, 'Password lama wajib diisi'), new_password: passwordSchema })
  .refine((v) => v.current_password !== v.new_password, {
    path: ['new_password'],
    message: 'Password baru harus berbeda dari password lama',
  });

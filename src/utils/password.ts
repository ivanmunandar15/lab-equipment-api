import bcrypt from 'bcryptjs';
import { randomInt } from 'crypto';
import { z } from 'zod';
import { isTest } from '../config/env';

export const BCRYPT_ROUNDS = isTest ? 4 : 12;

export const hashPassword = (plain: string) => bcrypt.hash(plain, BCRYPT_ROUNDS);
export const verifyPassword = (plain: string, hash: string) => bcrypt.compare(plain, hash);

/** Minimal 8 karakter (maks 72 = batas bcrypt), mengandung huruf dan angka. */
export const passwordSchema = z
  .string()
  .min(8, 'Password minimal 8 karakter')
  .max(72, 'Password maksimal 72 karakter')
  .regex(/[A-Za-z]/, 'Password harus mengandung huruf')
  .regex(/\d/, 'Password harus mengandung angka');

export function generateTempPassword(length = 14): string {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnpqrstuvwxyz';
  const digits = '23456789';
  const all = upper + lower + digits;
  const at = (s: string) => s[randomInt(s.length)];
  const chars = [at(upper), at(lower), at(digits)];
  while (chars.length < length) chars.push(at(all));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

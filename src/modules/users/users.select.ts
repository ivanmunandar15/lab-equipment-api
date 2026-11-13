/** Kolom user yang aman dikembalikan (tanpa password_hash). */
export const USER_PUBLIC_SELECT = {
  user_id: true,
  name: true,
  email: true,
  role: true,
  is_active: true,
  email_notifications: true,
  created_at: true,
  updated_at: true,
} as const;

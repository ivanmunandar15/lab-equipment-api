import type { RoleName } from '../config/permissions';

export interface AuthUser {
  user_id: string;
  name: string;
  email: string;
  role: RoleName;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

import type { Request } from 'express';
import type { RoleName } from '../../config/permissions';
import { audit } from '../activity-logs/audit.service';

export interface CompatActor {
  userId: string;
  role: RoleName;
  ip: string | null;
}

export const actorOf = (req: Request): CompatActor => ({ userId: req.user!.user_id, role: req.user!.role, ip: req.ip ?? null });

/** Hanya field yang berubah (seperti `diffFields` di store mock), tanpa updated_at. */
export function diffFields(before: Record<string, unknown>, after: Record<string, unknown>) {
  const oldData: Record<string, unknown> = {};
  const newData: Record<string, unknown> = {};
  for (const key of Object.keys(after)) {
    if (key === 'updated_at') continue;
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      oldData[key] = before[key];
      newData[key] = after[key];
    }
  }
  return { oldData, newData };
}

/** Catat activity log (best-effort di luar transaksi; kegagalan hanya di-log). */
export const log = (
  req: Request,
  entry: { action: string; entityType: string; entityId: string | null; oldData?: unknown; newData?: unknown },
) => audit.log({ userId: req.user!.user_id, ip: req.ip ?? null, ...entry });

import type { Prisma } from '@prisma/client';
import type { Request } from 'express';
import { getDb } from '../../config/db';
import { logger } from '../../config/logger';
import { sanitizeForAudit } from '../../utils/sanitize';

/** Aksi standar. Tahap berikutnya memakai konstanta ini agar penulisan seragam (UPPERCASE). */
export const AUDIT_ACTIONS = {
  CREATE: 'CREATE',
  UPDATE: 'UPDATE',
  DELETE: 'DELETE',
  LOGIN: 'LOGIN',
  CHANGE_PASSWORD: 'CHANGE_PASSWORD',
  RESET_PASSWORD: 'RESET_PASSWORD',
  BORROW: 'BORROW',
  RETURN: 'RETURN',
  CALIBRATE: 'CALIBRATE',
  MAINTENANCE_START: 'MAINTENANCE_START',
  MAINTENANCE_COMPLETE: 'MAINTENANCE_COMPLETE',
  MAINTENANCE_CANCEL: 'MAINTENANCE_CANCEL',
  START_CALIBRATION: 'START_CALIBRATION',
  REPORT_DAMAGE: 'REPORT_DAMAGE',
  EXPORT: 'EXPORT',
  IMPORT: 'IMPORT',
  ROTATE_API_KEY: 'ROTATE_API_KEY',
  REVOKE_API_KEY: 'REVOKE_API_KEY',
} as const;

/** entity_type standar (lowercase, sama dengan seed). */
export const AUDIT_ENTITIES = {
  USER: 'user',
  ROOM: 'room',
  EQUIPMENT: 'equipment',
  SUPPORTING_EQUIPMENT: 'supporting_equipment',
  BORROWING: 'borrowing',
  CALIBRATION: 'calibration',
  MAINTENANCE: 'maintenance',
  SENSOR: 'sensor',
  DOCUMENT: 'document',
} as const;

export interface AuditEntry {
  userId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  oldData?: unknown;
  newData?: unknown;
  ip?: string | null;
}

type LogClient = Pick<Prisma.TransactionClient, 'activityLog'>;

/**
 * Catat satu activity log. Field sensitif otomatis dibuang.
 *
 * - Di dalam transaksi: `audit.log(entry, tx)`. Log ikut commit/rollback bersama data bisnis,
 *   dan error penulisan akan membatalkan transaksi.
 * - Di luar transaksi: `audit.log(entry)`. Best-effort; kegagalan hanya dicatat di logger
 *   agar tidak menggagalkan request.
 */
async function log(entry: AuditEntry, tx?: LogClient): Promise<void> {
  const write = (client: LogClient) =>
    client.activityLog.create({
      data: {
        user_id: entry.userId ?? null,
        action: entry.action,
        entity_type: entry.entityType,
        entity_id: entry.entityId ?? null,
        old_data: sanitizeForAudit(entry.oldData),
        new_data: sanitizeForAudit(entry.newData),
        ip_address: entry.ip ?? null,
      },
    });

  if (tx) {
    await write(tx);
    return;
  }
  try {
    await write(getDb());
  } catch (err) {
    logger.error({ err, action: entry.action, entityType: entry.entityType }, 'Gagal mencatat activity log');
  }
}

/** Ambil konteks pelaku (userId + ip) dari request, untuk dipakai di controller. */
export const actorFrom = (req: Request) => ({ userId: req.user?.user_id ?? null, ip: req.ip ?? null });

export const audit = { log, actorFrom };

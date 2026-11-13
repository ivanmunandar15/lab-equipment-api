import { getDb } from '../../config/db';
import { AppError } from '../../utils/errors';
import { AUDIT_ACTIONS, AUDIT_ENTITIES, audit } from '../activity-logs/audit.service';
import { DAMAGE_RECIPIENT_ROLES, notifyRoles } from '../notifications/notify.service';
import type { ReportDamageBody } from '../borrowings/borrowings.schema';
import { EQUIPMENT_SELECT, presentEquipment } from './equipment.service';

/** Statuses yang boleh dilaporkan rusak. Alat borrowed dilaporkan lewat proses pengembalian. */
export const REPORTABLE_STATUSES = ['available', 'maintenance', 'calibration'] as const;

export async function reportDamage(id: string, body: ReportDamageBody, actor: { userId: string; ip: string | null }) {
  return getDb().$transaction(async (tx) => {
    await tx.$queryRaw`SELECT equipment_id FROM equipment WHERE equipment_id = ${id}::uuid FOR UPDATE`;
    const cur = await tx.equipment.findUnique({ where: { equipment_id: id }, select: EQUIPMENT_SELECT });
    if (!cur) throw AppError.notFound('Equipment tidak ditemukan');
    if (!cur.is_active) throw new AppError(409, 'EQUIPMENT_INACTIVE', 'Alat sudah dinonaktifkan');
    if (cur.status === 'borrowed') {
      throw new AppError(409, 'EQUIPMENT_BORROWED', 'Alat sedang dipinjam; laporkan kerusakan saat proses pengembalian');
    }
    if (cur.status === 'damaged') throw new AppError(409, 'ALREADY_DAMAGED', 'Alat sudah berstatus rusak');

    const res = await tx.equipment.updateMany({
      where: { equipment_id: id, status: { in: [...REPORTABLE_STATUSES] }, is_active: true },
      data: { status: 'damaged', condition: body.condition },
    });
    if (res.count !== 1) throw new AppError(409, 'EQUIPMENT_STATUS_CHANGED', 'Status alat baru saja berubah, coba lagi');

    // Equipment tidak punya kolom catatan: catatan disimpan di activity log & notifikasi.
    const notified = await notifyRoles(tx, DAMAGE_RECIPIENT_ROLES, {
      type: 'maintenance',
      title: `Alat rusak: ${cur.inventory_code}`,
      message: `${cur.equipment_name} dilaporkan rusak. Catatan: ${body.notes}`,
    });
    const row = await tx.equipment.findUnique({ where: { equipment_id: id }, select: EQUIPMENT_SELECT });
    const result = presentEquipment(row!);
    await audit.log(
      {
        ...actor,
        action: AUDIT_ACTIONS.REPORT_DAMAGE,
        entityType: AUDIT_ENTITIES.EQUIPMENT,
        entityId: id,
        oldData: { status: cur.status, condition: cur.condition },
        newData: { status: 'damaged', condition: body.condition, notes: body.notes, notified },
      },
      tx,
    );
    return result;
  });
}

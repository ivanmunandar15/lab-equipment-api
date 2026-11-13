import { env } from '../../config/env';
import { getDb } from '../../config/db';
import { PERMISSIONS, type RoleName } from '../../config/permissions';
import { AppError } from '../../utils/errors';
import * as equipmentService from '../equipment/equipment.service';
import * as supportingService from '../supporting-equipment/supporting-equipment.service';

export interface Viewer {
  userId: string;
  role: RoleName;
}

export type ScanAction = 'borrow' | 'return' | 'report_damage';
const REPORTABLE = ['available', 'maintenance', 'calibration'];
const RETURN_REASON = 'Hanya peminjam, admin, atau SPV yang dapat mengembalikan';

const inactive = (what: 'alat' | 'item') => new AppError(410, 'ITEM_INACTIVE', `${what === 'alat' ? 'Alat' : 'Item'} sudah dinonaktifkan`);
const unknownQr = () => AppError.notFound('QR tidak dikenali');

const mayReturn = (ownerId: string, v: Viewer) => ownerId === v.userId || PERMISSIONS.borrowings.returnAny.includes(v.role);
const mayBorrow = (v: Viewer) => PERMISSIONS.borrowings.write.includes(v.role);

/** GET /scan/eq/:qrToken — selalu data terbaru dari DB (tidak ada cache). */
export async function scanEquipment(qrToken: string, viewer: Viewer) {
  const found = await getDb().equipment.findUnique({
    where: { qr_token: qrToken },
    select: { equipment_id: true, is_active: true },
  });
  if (!found) throw unknownQr();
  if (!found.is_active) throw inactive('alat');

  const eq = await equipmentService.getById(found.equipment_id);
  const warnings: string[] = [];
  const actions: ScanAction[] = [];
  let reason: string | null = null;

  const ab = eq.active_borrowing ? { ...eq.active_borrowing, can_return: mayReturn(eq.active_borrowing.user.user_id, viewer) } : null;

  if (eq.calibration_state === 'overdue') warnings.push('calibration_overdue');

  switch (eq.status) {
    case 'available':
      if (!mayBorrow(viewer)) reason = 'Role Anda tidak berhak meminjam';
      else if (eq.calibration_state === 'overdue' && env.CALIBRATION_OVERDUE_POLICY === 'block') reason = 'Kalibrasi alat sudah terlambat; peminjaman diblokir';
      else actions.push('borrow');
      actions.push('report_damage');
      break;
    case 'borrowed':
      if (ab?.can_return) actions.push('return');
      else reason = ab ? `${RETURN_REASON}. Sedang dipinjam oleh ${ab.user.name}` : 'Alat sedang dipinjam';
      break;
    case 'damaged':
      reason = 'Alat rusak dan tidak dapat dipinjam';
      break;
    case 'maintenance':
      reason = 'Alat sedang dalam maintenance';
      break;
    case 'calibration':
      reason = 'Alat sedang dalam kalibrasi';
      break;
  }
  if (eq.status !== 'available' && REPORTABLE.includes(eq.status)) actions.push('report_damage');

  return { type: 'equipment' as const, ...eq, active_borrowing: ab, available_actions: actions, reason, warnings, server_time: new Date().toISOString() };
}

/** GET /scan/sp/:qrToken — QR mewakili jenis item; ada stok + daftar peminjam aktif. */
export async function scanSupporting(qrToken: string, viewer: Viewer) {
  const found = await getDb().supportingEquipment.findUnique({
    where: { qr_token: qrToken },
    select: { supporting_equipment_id: true, is_active: true },
  });
  if (!found) throw unknownQr();
  if (!found.is_active) throw inactive('item');

  const sp = await supportingService.getById(found.supporting_equipment_id);
  const loans = sp.active_borrowings.map((l) => ({ ...l, can_return: mayReturn(l.user.user_id, viewer) }));
  const actions: ScanAction[] = [];
  const reasons: string[] = [];

  if (sp.status === 'damaged') reasons.push('Item rusak dan tidak dapat dipinjam');
  else if (sp.available_quantity <= 0) reasons.push('Stok habis');
  else if (!mayBorrow(viewer)) reasons.push('Role Anda tidak berhak meminjam');
  else actions.push('borrow');

  if (loans.some((l) => l.can_return)) actions.push('return');
  else if (loans.length && actions.length === 0) reasons.push(RETURN_REASON);

  return {
    type: 'supporting' as const,
    ...sp,
    active_borrowings: loans,
    max_borrow_quantity: actions.includes('borrow') ? sp.available_quantity : 0,
    available_actions: actions,
    reason: actions.length ? null : reasons[0] ?? null,
    warnings: [] as string[],
    server_time: new Date().toISOString(),
  };
}

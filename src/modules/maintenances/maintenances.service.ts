import type { EquipmentStatus, Prisma } from '@prisma/client';
import { getDb } from '../../config/db';
import { AppError } from '../../utils/errors';
import { buildMeta, getPagination, resolveSort } from '../../utils/pagination';
import { AUDIT_ACTIONS, AUDIT_ENTITIES, audit } from '../activity-logs/audit.service';
import type { CreateMaintenanceBody, ListMaintenancesQuery, UpdateMaintenanceBody } from './maintenances.schema';
import { TRANSITIONS, canTransition, isFinal } from './maintenances.state';

type Tx = Prisma.TransactionClient;
export interface Actor {
  userId: string;
  ip: string | null;
}

const DAY_MS = 86_400_000;
const SORTABLE = ['maintenance_date', 'completion_date', 'created_at', 'status', 'maintenance_type'];
/** Decimal Prisma -> number (kontrak frontend: number). Decimal(15,2) masih aman di dalam presisi double. */
const money = (v: { toString(): string } | null) => (v === null ? null : Number(v.toString()));

const M_SELECT = {
  maintenance_id: true, equipment_id: true, technician_id: true, maintenance_type: true, maintenance_date: true,
  completion_date: true, description: true, cost: true, status: true, replaced_spare_parts: true, notes: true,
  prev_equipment_status: true, created_at: true, updated_at: true,
} satisfies Prisma.MaintenanceSelect;
type MRow = Prisma.MaintenanceGetPayload<{ select: typeof M_SELECT }>;

const present = (r: MRow) => ({ ...r, cost: money(r.cost) });

async function hydrate(rows: MRow[]) {
  const db = getDb();
  const [eq, users] = rows.length
    ? await Promise.all([
        db.equipment.findMany({
          where: { equipment_id: { in: [...new Set(rows.map((r) => r.equipment_id))] } },
          select: { equipment_id: true, inventory_code: true, equipment_name: true, status: true },
        }),
        db.user.findMany({ where: { user_id: { in: [...new Set(rows.map((r) => r.technician_id))] } }, select: { user_id: true, name: true } }),
      ])
    : [[], []];
  const eqMap = new Map(eq.map((e) => [e.equipment_id, e]));
  const uMap = new Map(users.map((u) => [u.user_id, u]));
  return rows.map((r) => ({ ...present(r), equipment: eqMap.get(r.equipment_id) ?? null, technician: uMap.get(r.technician_id) ?? null }));
}

export async function list(q: ListMaintenancesQuery) {
  const db = getDb();
  const where: Prisma.MaintenanceWhereInput = {
    ...(q.maintenance_type ? { maintenance_type: q.maintenance_type } : {}),
    ...(q.status ? { status: q.status } : {}),
    ...(q.equipment_id ? { equipment_id: q.equipment_id } : {}),
    ...(q.technician_id ? { technician_id: q.technician_id } : {}),
    ...(q.date_from || q.date_to
      ? {
          maintenance_date: {
            ...(q.date_from ? { gte: q.date_from } : {}),
            ...(q.date_to ? { lt: new Date(q.date_to.getTime() + DAY_MS) } : {}), // inklusif sampai akhir hari UTC
          },
        }
      : {}),
    ...(q.search
      ? { OR: [{ description: { contains: q.search, mode: 'insensitive' } }, { notes: { contains: q.search, mode: 'insensitive' } }] }
      : {}),
  };
  const sort = resolveSort(q.sort, SORTABLE, 'maintenance_date');
  const { page, limit, skip, take } = getPagination(q);
  const [rows, total] = await Promise.all([
    db.maintenance.findMany({ where, orderBy: [{ [sort]: q.order }, { maintenance_id: 'asc' }], skip, take, select: M_SELECT }),
    db.maintenance.count({ where }),
  ]);
  return { items: await hydrate(rows), meta: buildMeta(page, limit, total) };
}

export async function getById(id: string) {
  const row = await getDb().maintenance.findUnique({ where: { maintenance_id: id }, select: M_SELECT });
  if (!row) throw AppError.notFound('Maintenance tidak ditemukan');
  return (await hydrate([row]))[0];
}

async function assertTechnician(tx: Tx, userId: string) {
  const u = await tx.user.findUnique({ where: { user_id: userId }, select: { user_id: true, is_active: true } });
  if (!u || !u.is_active) throw AppError.unprocessable('Validasi gagal', [{ path: 'technician_id', message: 'User tidak ditemukan atau tidak aktif' }]);
}

export async function create(body: CreateMaintenanceBody, actor: Actor) {
  return getDb().$transaction(async (tx) => {
    const eq = await tx.equipment.findUnique({ where: { equipment_id: body.equipment_id }, select: { equipment_id: true, is_active: true } });
    if (!eq) throw AppError.unprocessable('Validasi gagal', [{ path: 'equipment_id', message: 'Alat tidak ditemukan' }]);
    if (!eq.is_active) throw new AppError(409, 'EQUIPMENT_INACTIVE', 'Alat sudah dinonaktifkan');
    const technicianId = body.technician_id ?? actor.userId;
    if (technicianId !== actor.userId) await assertTechnician(tx, technicianId);

    const row = await tx.maintenance.create({
      data: {
        equipment_id: body.equipment_id,
        technician_id: technicianId,
        maintenance_type: body.maintenance_type,
        maintenance_date: body.maintenance_date,
        description: body.description ?? null,
        cost: body.cost ?? null,
        replaced_spare_parts: body.replaced_spare_parts ?? null,
        notes: body.notes ?? null,
        status: 'scheduled',
      },
      select: M_SELECT,
    });
    await audit.log({ ...actor, action: AUDIT_ACTIONS.CREATE, entityType: AUDIT_ENTITIES.MAINTENANCE, entityId: row.maintenance_id, newData: present(row) }, tx);
    return (await hydrate([row]))[0];
  });
}

const invalid = (path: string, message: string) => AppError.unprocessable('Validasi gagal', [{ path, message }]);

export async function update(id: string, body: UpdateMaintenanceBody, actor: Actor) {
  return getDb().$transaction(async (tx) => {
    await tx.$queryRaw`SELECT maintenance_id FROM maintenances WHERE maintenance_id = ${id}::uuid FOR UPDATE`;
    const cur = await tx.maintenance.findUnique({ where: { maintenance_id: id }, select: M_SELECT });
    if (!cur) throw AppError.notFound('Maintenance tidak ditemukan');
    if (isFinal(cur.status)) {
      throw new AppError(409, 'MAINTENANCE_LOCKED', `Maintenance berstatus ${cur.status} tidak dapat diubah`);
    }

    const { status: target, completion_date, equipment_damaged, ...fields } = body;
    const moving = target !== undefined && target !== cur.status;
    if (moving && !canTransition(cur.status, target)) {
      throw new AppError(422, 'INVALID_TRANSITION', `Transisi ${cur.status} → ${target} tidak diizinkan`, {
        from: cur.status, to: target, allowed: TRANSITIONS[cur.status],
      });
    }
    const completing = moving && target === 'completed';
    if (completion_date !== undefined && !completing) throw invalid('completion_date', 'Hanya boleh diisi saat status → completed');
    if (equipment_damaged !== undefined && !completing) throw invalid('equipment_damaged', 'Hanya boleh diisi saat status → completed');
    if (fields.technician_id && fields.technician_id !== cur.technician_id) await assertTechnician(tx, fields.technician_id);

    const now = new Date();
    if (completion_date && completion_date.getTime() > now.getTime() + 5 * 60_000) throw invalid('completion_date', 'tidak boleh di masa depan');

    const data: Prisma.MaintenanceUncheckedUpdateInput = { ...fields };
    let equipmentAfter: { status: EquipmentStatus } | null = null;
    let action: string = AUDIT_ACTIONS.UPDATE;

    if (moving) {
      data.status = target;
      // Alat dikunci hanya jika transisi menyentuh statusnya; urutan lock: maintenance → equipment (konsisten).
      if (target === 'in_progress' || (cur.status === 'in_progress' && (target === 'completed' || target === 'cancelled'))) {
        await tx.$queryRaw`SELECT equipment_id FROM equipment WHERE equipment_id = ${cur.equipment_id}::uuid FOR UPDATE`;
      }
      const eq = await tx.equipment.findUnique({ where: { equipment_id: cur.equipment_id }, select: { status: true, is_active: true } });
      if (!eq) throw AppError.internal('Alat untuk maintenance ini tidak ditemukan');

      if (target === 'in_progress') {
        action = AUDIT_ACTIONS.MAINTENANCE_START;
        if (!eq.is_active) throw new AppError(409, 'EQUIPMENT_INACTIVE', 'Alat sudah dinonaktifkan');
        if (eq.status === 'borrowed') throw new AppError(409, 'EQUIPMENT_BORROWED', 'Alat sedang dipinjam; tidak dapat dimaintenance');
        if (eq.status === 'calibration') throw new AppError(409, 'EQUIPMENT_IN_CALIBRATION', 'Alat sedang dikalibrasi');
        if (eq.status === 'maintenance') throw new AppError(409, 'EQUIPMENT_IN_MAINTENANCE', 'Alat sudah dalam maintenance lain');
        const res = await tx.equipment.updateMany({
          where: { equipment_id: cur.equipment_id, status: { in: ['available', 'damaged'] } },
          data: { status: 'maintenance' },
        });
        if (res.count !== 1) throw new AppError(409, 'EQUIPMENT_STATUS_CHANGED', 'Status alat baru saja berubah, coba lagi');
        data.prev_equipment_status = eq.status; // untuk dikembalikan bila dibatalkan
        equipmentAfter = { status: 'maintenance' };
      } else if (target === 'completed') {
        action = AUDIT_ACTIONS.MAINTENANCE_COMPLETE;
        data.completion_date = completion_date ?? now;
        data.prev_equipment_status = null;
        const next: EquipmentStatus = equipment_damaged ? 'damaged' : 'available';
        // Hanya sentuh alat yang masih berstatus maintenance (admin mungkin sudah mengubahnya manual).
        const res = await tx.equipment.updateMany({ where: { equipment_id: cur.equipment_id, status: 'maintenance' }, data: { status: next } });
        equipmentAfter = { status: res.count === 1 ? next : eq.status };
      } else if (target === 'cancelled') {
        action = AUDIT_ACTIONS.MAINTENANCE_CANCEL;
        data.prev_equipment_status = null;
        if (cur.status === 'in_progress') {
          const back: EquipmentStatus = cur.prev_equipment_status ?? 'available';
          const res = await tx.equipment.updateMany({ where: { equipment_id: cur.equipment_id, status: 'maintenance' }, data: { status: back } });
          equipmentAfter = { status: res.count === 1 ? back : eq.status };
        }
      }
    }

    const row = await tx.maintenance.update({ where: { maintenance_id: id }, data, select: M_SELECT });
    await audit.log(
      {
        ...actor,
        action,
        entityType: AUDIT_ENTITIES.MAINTENANCE,
        entityId: id,
        oldData: present(cur),
        newData: { ...present(row), ...(equipmentAfter ? { equipment_status: equipmentAfter.status } : {}) },
      },
      tx,
    );
    return { ...(await hydrate([row]))[0], ...(equipmentAfter ? { equipment_status_after: equipmentAfter.status } : {}) };
  });
}

/** Hapus permanen hanya untuk jadwal yang belum dijalankan; selain itu gunakan status cancelled. */
export async function remove(id: string, actor: Actor) {
  return getDb().$transaction(async (tx) => {
    await tx.$queryRaw`SELECT maintenance_id FROM maintenances WHERE maintenance_id = ${id}::uuid FOR UPDATE`;
    const cur = await tx.maintenance.findUnique({ where: { maintenance_id: id }, select: M_SELECT });
    if (!cur) throw AppError.notFound('Maintenance tidak ditemukan');
    if (cur.status !== 'scheduled') {
      throw new AppError(409, 'MAINTENANCE_NOT_DELETABLE', 'Hanya maintenance berstatus scheduled yang dapat dihapus; gunakan status cancelled untuk membatalkan');
    }
    await tx.maintenance.delete({ where: { maintenance_id: id } });
    await audit.log({ ...actor, action: AUDIT_ACTIONS.DELETE, entityType: AUDIT_ENTITIES.MAINTENANCE, entityId: id, oldData: present(cur) }, tx);
    return present(cur);
  });
}

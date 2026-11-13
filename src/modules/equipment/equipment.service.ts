import type { Prisma } from '@prisma/client';
import { getDb } from '../../config/db';
import { PERMISSIONS, type RoleName } from '../../config/permissions';
import { AppError } from '../../utils/errors';
import { buildMeta, getPagination, resolveSort, type PaginationQuery } from '../../utils/pagination';
import { uniqueViolation } from '../../utils/prisma-errors';
import { equipmentQrUrl, qrPng } from '../../utils/qr';
import { generateQrToken } from '../../utils/qr-token';
import { assertRoomCapacity, lockRooms, type CapacityWarning } from '../rooms/room-capacity';
import { calibrationState, calibrationWhere, dateOnly, remainingUsefulLifeYears } from './equipment.derive';
import type {
  CreateEquipmentBody,
  ExportQuery,
  ListEquipmentQuery,
  UpdateEquipmentBody,
} from './equipment.schema';

const SORTABLE = [
  'equipment_name',
  'inventory_code',
  'equipment_type',
  'status',
  'condition',
  'next_calibration_date',
  'purchase_date',
  'created_at',
  'updated_at',
];

export const EQUIPMENT_SELECT = {
  equipment_id: true,
  inventory_code: true,
  qr_token: true,
  equipment_name: true,
  equipment_type: true,
  brand: true,
  model: true,
  room_id: true,
  status: true,
  condition: true,
  purchase_date: true,
  purchase_price: true,
  useful_life_years: true,
  specifications: true,
  next_calibration_date: true,
  is_active: true,
  created_at: true,
  updated_at: true,
  room: { select: { room_id: true, room_code: true, room_name: true, equipment_capacity: true, is_active: true } },
} satisfies Prisma.EquipmentSelect;

export type EquipmentRow = Prisma.EquipmentGetPayload<{ select: typeof EQUIPMENT_SELECT }>;

/** Bentuk respons: tambah qr_url, calibration_state, remaining_useful_life_years; tanggal → YYYY-MM-DD. */
export function presentEquipment(row: EquipmentRow, now: Date = new Date()) {
  return {
    ...row,
    purchase_date: dateOnly(row.purchase_date),
    next_calibration_date: dateOnly(row.next_calibration_date),
    purchase_price: row.purchase_price === null || row.purchase_price === undefined ? null : Number(row.purchase_price.toString()),
    qr_url: equipmentQrUrl(row.qr_token),
    calibration_state: calibrationState(row.next_calibration_date, now),
    remaining_useful_life_years: remainingUsefulLifeYears(row.purchase_date, row.useful_life_years, now),
  };
}

type Filters = Partial<Pick<ListEquipmentQuery, 'status' | 'condition' | 'room_id' | 'equipment_type' | 'calibration_state' | 'is_active' | 'search'>> &
  Pick<Partial<ExportQuery>, 'ids'>;

/** Dipakai bersama oleh list dan ekspor. */
export function buildWhere(f: Filters, now: Date = new Date()): Prisma.EquipmentWhereInput {
  return {
    ...(f.status ? { status: f.status } : {}),
    ...(f.condition ? { condition: f.condition } : {}),
    ...(f.room_id ? { room_id: f.room_id } : {}),
    ...(f.equipment_type ? { equipment_type: { equals: f.equipment_type, mode: 'insensitive' } } : {}),
    ...(f.is_active !== undefined ? { is_active: f.is_active } : {}),
    ...(f.calibration_state ? { next_calibration_date: calibrationWhere(f.calibration_state, now) } : {}),
    ...(f.ids ? { equipment_id: { in: f.ids } } : {}),
    ...(f.search
      ? {
          OR: [
            { equipment_name: { contains: f.search, mode: 'insensitive' } },
            { inventory_code: { contains: f.search, mode: 'insensitive' } },
          ],
        }
      : {}),
  };
}

export async function list(q: ListEquipmentQuery) {
  const db = getDb();
  const where = buildWhere(q);
  const { page, limit, skip, take } = getPagination(q);
  const sortField = resolveSort(q.sort, SORTABLE, 'created_at');
  const [rows, total] = await Promise.all([
    db.equipment.findMany({
      where,
      orderBy: [{ [sortField]: q.order }, { equipment_id: 'asc' }],
      skip,
      take,
      select: EQUIPMENT_SELECT,
    }),
    db.equipment.count({ where }),
  ]);
  const now = new Date();
  return { items: rows.map((r) => presentEquipment(r, now)), meta: buildMeta(page, limit, total) };
}

/** Bentuk sama dengan respons create/update (dipakai sebagai old_data audit). */
export async function getBasic(id: string) {
  const row = await getDb().equipment.findUnique({ where: { equipment_id: id }, select: EQUIPMENT_SELECT });
  if (!row) throw AppError.notFound('Equipment tidak ditemukan');
  return presentEquipment(row);
}

export async function getById(id: string) {
  const db = getDb();
  const row = await db.equipment.findUnique({
    where: { equipment_id: id },
    select: { ...EQUIPMENT_SELECT, _count: { select: { documents: true } } },
  });
  if (!row) throw AppError.notFound('Equipment tidak ditemukan');

  const active = await db.borrowingDetail.findFirst({
    where: { equipment_id: id, borrowing: { borrowing_status: 'borrowed' } },
    select: {
      detail_id: true,
      initial_condition: true,
      borrowing: {
        select: {
          borrowing_id: true,
          borrowing_time: true,
          expected_return_time: true,
          purpose: true,
          usage_location: true,
          user: { select: { user_id: true, name: true, email: true } },
        },
      },
    },
  });

  const { _count, ...equipment } = row;
  return {
    ...presentEquipment(equipment),
    documents_count: _count.documents,
    active_borrowing: active
      ? {
          ...active.borrowing,
          detail_id: active.detail_id,
          initial_condition: active.initial_condition,
          is_overdue: active.borrowing.expected_return_time.getTime() < Date.now(),
        }
      : null,
  };
}

const dupCode = () => AppError.conflict('inventory_code sudah dipakai', { field: 'inventory_code' });

async function loadActiveRoom(tx: Prisma.TransactionClient, roomId: string) {
  const room = await tx.room.findUnique({
    where: { room_id: roomId },
    select: { room_id: true, room_code: true, equipment_capacity: true, is_active: true },
  });
  if (!room || !room.is_active) {
    throw AppError.unprocessable('Validasi gagal', [
      { path: 'room_id', message: 'Ruangan tidak ditemukan atau tidak aktif' },
    ]);
  }
  return room;
}

export async function create(body: CreateEquipmentBody) {
  const db = getDb();
  if (await db.equipment.findUnique({ where: { inventory_code: body.inventory_code }, select: { equipment_id: true } })) {
    throw dupCode();
  }
  // qr_token dibuat server SEKALI di sini; ulangi dengan transaksi baru jika bentrok.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await db.$transaction(async (tx) => {
        const room = await loadActiveRoom(tx, body.room_id);
        await lockRooms(tx, [room.room_id]);
        const warning = await assertRoomCapacity(tx, room, 1);
        const row = await tx.equipment.create({
          data: { ...body, qr_token: generateQrToken() },
          select: EQUIPMENT_SELECT,
        });
        return { ...presentEquipment(row), ...(warning ? { warnings: [warning] } : {}) };
      });
    } catch (err) {
      const v = uniqueViolation(err);
      if (v === null) throw err;
      if (v.includes('qr_token')) continue;
      if (v.includes('inventory_code')) throw dupCode();
      throw err;
    }
  }
  throw AppError.internal('Gagal membuat qr_token unik, coba lagi');
}

const borrowedError = () =>
  new AppError(409, 'EQUIPMENT_BORROWED', 'Alat sedang dipinjam; status dikelola oleh proses peminjaman/pengembalian');

export async function update(id: string, body: UpdateEquipmentBody, actorRole: RoleName) {
  try {
    return await getDb().$transaction(async (tx) => {
      const cur = await tx.equipment.findUnique({
        where: { equipment_id: id },
        select: { equipment_id: true, inventory_code: true, room_id: true, status: true, is_active: true },
      });
      if (!cur) throw AppError.notFound('Equipment tidak ditemukan');

      if (body.inventory_code !== undefined && body.inventory_code !== cur.inventory_code) {
        if (!PERMISSIONS.equipment.changeInventoryCode.includes(actorRole)) {
          throw AppError.forbidden('Anda tidak berhak mengubah inventory_code');
        }
        if (await tx.equipment.findUnique({ where: { inventory_code: body.inventory_code }, select: { equipment_id: true } })) {
          throw dupCode();
        }
      }
      if (cur.status === 'borrowed' && (body.status !== undefined || body.is_active === false)) throw borrowedError();

      const nextRoomId = body.room_id ?? cur.room_id;
      const roomChanged = nextRoomId !== cur.room_id;
      const nextActive = body.is_active ?? cur.is_active;
      const reactivating = nextActive && !cur.is_active;

      const warnings: CapacityWarning[] = [];
      if (nextActive && (roomChanged || reactivating)) {
        // alat "masuk" ke ruangan tujuan → cek kapasitas
        const room = await loadActiveRoom(tx, nextRoomId);
        await lockRooms(tx, [room.room_id]);
        const w = await assertRoomCapacity(tx, room, 1);
        if (w) warnings.push(w);
      } else if (roomChanged) {
        await loadActiveRoom(tx, nextRoomId);
      }

      // `body` hanya berisi field whitelist Zod → qr_token tidak pernah ikut terupdate.
      const row = await tx.equipment.update({ where: { equipment_id: id }, data: body, select: EQUIPMENT_SELECT });
      return { ...presentEquipment(row), ...(warnings.length ? { warnings } : {}) };
    });
  } catch (err) {
    if (uniqueViolation(err)?.includes('inventory_code')) throw dupCode();
    throw err;
  }
}

/** Soft delete; ditolak jika sedang dipinjam. */
export async function remove(id: string) {
  return getDb().$transaction(async (tx) => {
    const cur = await tx.equipment.findUnique({
      where: { equipment_id: id },
      select: { equipment_id: true, status: true, is_active: true },
    });
    if (!cur) throw AppError.notFound('Equipment tidak ditemukan');
    const activeBorrowings = await tx.borrowingDetail.count({
      where: { equipment_id: id, borrowing: { borrowing_status: 'borrowed' } },
    });
    if (cur.status === 'borrowed' || activeBorrowings > 0) throw borrowedError();
    const row = await tx.equipment.update({
      where: { equipment_id: id },
      data: { is_active: false },
      select: EQUIPMENT_SELECT,
    });
    return presentEquipment(row);
  });
}

export async function getQrPng(id: string, size: number) {
  const row = await getDb().equipment.findUnique({
    where: { equipment_id: id },
    select: { inventory_code: true, qr_token: true },
  });
  if (!row) throw AppError.notFound('Equipment tidak ditemukan');
  return { inventory_code: row.inventory_code, png: await qrPng(equipmentQrUrl(row.qr_token), size) };
}

// ───────── Sub-resource ─────────

async function ensureExists(id: string) {
  const row = await getDb().equipment.findUnique({ where: { equipment_id: id }, select: { equipment_id: true } });
  if (!row) throw AppError.notFound('Equipment tidak ditemukan');
}

const USER_BRIEF = { select: { user_id: true, name: true } } as const;
/** Decimal Prisma -> number (kontrak frontend: number). Decimal(15,2) masih aman di dalam presisi double. */
const money = (v: { toString(): string } | null) => (v === null ? null : Number(v.toString()));

export async function listBorrowings(id: string, q: PaginationQuery & { borrowing_status?: 'borrowed' | 'returned' }) {
  await ensureExists(id);
  const db = getDb();
  const where: Prisma.BorrowingDetailWhereInput = {
    equipment_id: id,
    ...(q.borrowing_status ? { borrowing: { borrowing_status: q.borrowing_status } } : {}),
  };
  const sort = resolveSort(q.sort, ['borrowing_time', 'expected_return_time'], 'borrowing_time');
  const { page, limit, skip, take } = getPagination(q);
  const [rows, total] = await Promise.all([
    db.borrowingDetail.findMany({
      where,
      orderBy: { borrowing: { [sort]: q.order } },
      skip,
      take,
      select: {
        detail_id: true,
        initial_condition: true,
        final_condition: true,
        has_damage: true,
        damage_notes: true,
        borrowing: {
          select: {
            borrowing_id: true,
            borrowing_time: true,
            expected_return_time: true,
            actual_return_time: true,
            purpose: true,
            usage_location: true,
            borrowing_status: true,
            notes: true,
            user: { select: { user_id: true, name: true, email: true } },
          },
        },
      },
    }),
    db.borrowingDetail.count({ where }),
  ]);
  const now = Date.now();
  const items = rows.map((r) => ({
    ...r,
    // overdue tidak disimpan: dihitung dari expected_return_time dan status
    borrowing: {
      ...r.borrowing,
      is_overdue: r.borrowing.borrowing_status === 'borrowed' && r.borrowing.expected_return_time.getTime() < now,
    },
  }));
  return { items, meta: buildMeta(page, limit, total) };
}

export async function listCalibrations(id: string, q: PaginationQuery & { calibration_result?: 'passed' | 'failed' }) {
  await ensureExists(id);
  const db = getDb();
  const where: Prisma.CalibrationWhereInput = {
    equipment_id: id,
    ...(q.calibration_result ? { calibration_result: q.calibration_result } : {}),
  };
  const sort = resolveSort(q.sort, ['calibration_date', 'next_calibration_date', 'created_at'], 'calibration_date');
  const { page, limit, skip, take } = getPagination(q);
  const [rows, total] = await Promise.all([
    db.calibration.findMany({ where, orderBy: { [sort]: q.order }, skip, take, select: { calibration_id: true, equipment_id: true, calibration_date: true, next_calibration_date: true, calibration_provider: true, certificate_number: true, certificate_file_url: true, calibration_result: true, cost: true, notes: true, created_at: true, technician: USER_BRIEF } }),
    db.calibration.count({ where }),
  ]);
  const items = rows.map((r) => ({
    ...r,
    calibration_date: dateOnly(r.calibration_date),
    next_calibration_date: dateOnly(r.next_calibration_date),
    cost: money(r.cost),
  }));
  return { items, meta: buildMeta(page, limit, total) };
}

export async function listMaintenances(
  id: string,
  q: PaginationQuery & { status?: Prisma.MaintenanceWhereInput['status']; maintenance_type?: 'routine' | 'repair' },
) {
  await ensureExists(id);
  const db = getDb();
  const where: Prisma.MaintenanceWhereInput = {
    equipment_id: id,
    ...(q.status ? { status: q.status } : {}),
    ...(q.maintenance_type ? { maintenance_type: q.maintenance_type } : {}),
  };
  const sort = resolveSort(q.sort, ['maintenance_date', 'completion_date', 'created_at'], 'maintenance_date');
  const { page, limit, skip, take } = getPagination(q);
  const [rows, total] = await Promise.all([
    db.maintenance.findMany({ where, orderBy: { [sort]: q.order }, skip, take, select: { maintenance_id: true, equipment_id: true, maintenance_type: true, maintenance_date: true, completion_date: true, description: true, cost: true, status: true, replaced_spare_parts: true, notes: true, created_at: true, updated_at: true, technician: USER_BRIEF } }),
    db.maintenance.count({ where }),
  ]);
  return { items: rows.map((r) => ({ ...r, cost: money(r.cost) })), meta: buildMeta(page, limit, total) };
}

export async function listDocuments(
  id: string,
  q: PaginationQuery & { document_type?: Prisma.DocumentWhereInput['document_type'] },
) {
  await ensureExists(id);
  const db = getDb();
  const where: Prisma.DocumentWhereInput = {
    equipment_id: id,
    ...(q.document_type ? { document_type: q.document_type } : {}),
  };
  const sort = resolveSort(q.sort, ['uploaded_at', 'file_name', 'document_type'], 'uploaded_at');
  const { page, limit, skip, take } = getPagination(q);
  const [rows, total] = await Promise.all([
    db.document.findMany({ where, orderBy: { [sort]: q.order }, skip, take, select: { document_id: true, equipment_id: true, document_type: true, file_name: true, file_url: true, file_type: true, file_size: true, uploaded_at: true, uploader: USER_BRIEF } }),
    db.document.count({ where }),
  ]);
  // BigInt tidak bisa di-serialize JSON
  const items = rows.map((r) => ({ ...r, file_size: r.file_size === null ? null : Number(r.file_size) }));
  return { items, meta: buildMeta(page, limit, total) };
}

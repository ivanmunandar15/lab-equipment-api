import type { Prisma } from '@prisma/client';
import { getDb } from '../../config/db';
import { AppError } from '../../utils/errors';
import { buildMeta, getPagination, resolveSort } from '../../utils/pagination';
import { uniqueViolation } from '../../utils/prisma-errors';
import { assertRoomCapacity, capacityInfo, lockRooms, type CapacityWarning } from './room-capacity';
import type { CreateRoomBody, ListRoomsQuery, UpdateRoomBody } from './rooms.schema';

const SORTABLE = ['room_code', 'room_name', 'equipment_capacity', 'is_active', 'created_at', 'updated_at'];

const ROOM_SELECT = {
  room_id: true,
  room_code: true,
  room_name: true,
  equipment_capacity: true,
  person_in_charge: true,
  description: true,
  is_active: true,
  created_at: true,
  updated_at: true,
  pic: { select: { user_id: true, name: true, email: true } },
  _count: { select: { equipment: { where: { is_active: true } } } },
  sensors: {
    where: { is_active: true },
    orderBy: { sensor_code: 'asc' },
    select: {
      sensor_id: true,
      sensor_code: true,
      sensor_type: true,
      unit: true,
      sensor_location: true,
      sensor_status: true,
      min_threshold: true,
      max_threshold: true,
      monitorings: { orderBy: { measurement_time: 'desc' }, take: 1, select: { value: true, measurement_time: true } },
    },
  },
} satisfies Prisma.RoomSelect;

type RoomRow = Prisma.RoomGetPayload<{ select: typeof ROOM_SELECT }>;

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export function presentRoom(r: RoomRow) {
  const used = r._count.equipment;
  const { _count, sensors, ...rest } = r;
  void _count;
  return {
    ...rest,
    active_equipment_count: used,
    capacity: capacityInfo(r.equipment_capacity, used),
    latest_readings: sensors.map((s) => {
      const last = s.monitorings[0];
      const value = num(last?.value);
      const min = num(s.min_threshold);
      const max = num(s.max_threshold);
      return {
        sensor_id: s.sensor_id,
        sensor_code: s.sensor_code,
        sensor_type: s.sensor_type,
        unit: s.unit,
        sensor_location: s.sensor_location,
        sensor_status: s.sensor_status,
        min_threshold: min,
        max_threshold: max,
        value,
        measurement_time: last?.measurement_time ?? null,
        threshold_state:
          value === null ? null : min !== null && value < min ? 'below_min' : max !== null && value > max ? 'above_max' : 'normal',
      };
    }),
  };
}

export async function list(q: ListRoomsQuery) {
  const db = getDb();
  const where: Prisma.RoomWhereInput = {
    ...(q.is_active !== undefined ? { is_active: q.is_active } : {}),
    ...(q.person_in_charge ? { person_in_charge: q.person_in_charge } : {}),
    ...(q.search
      ? {
          OR: [
            { room_code: { contains: q.search, mode: 'insensitive' } },
            { room_name: { contains: q.search, mode: 'insensitive' } },
          ],
        }
      : {}),
  };
  const { page, limit, skip, take } = getPagination(q);
  const sortField = resolveSort(q.sort, SORTABLE, 'created_at');
  const [rows, total] = await Promise.all([
    db.room.findMany({ where, orderBy: [{ [sortField]: q.order }, { room_id: 'asc' }], skip, take, select: ROOM_SELECT }),
    db.room.count({ where }),
  ]);
  return { items: rows.map(presentRoom), meta: buildMeta(page, limit, total) };
}

export async function getById(id: string) {
  const row = await getDb().room.findUnique({ where: { room_id: id }, select: ROOM_SELECT });
  if (!row) throw AppError.notFound('Ruangan tidak ditemukan');
  return presentRoom(row);
}

async function assertPic(userId: string) {
  const u = await getDb().user.findUnique({ where: { user_id: userId }, select: { is_active: true } });
  if (!u || !u.is_active) {
    throw AppError.unprocessable('Validasi gagal', [
      { path: 'person_in_charge', message: 'User tidak ditemukan atau tidak aktif' },
    ]);
  }
}

const dupCode = () => AppError.conflict('room_code sudah dipakai', { field: 'room_code' });

export async function create(body: CreateRoomBody) {
  const db = getDb();
  if (await db.room.findUnique({ where: { room_code: body.room_code }, select: { room_id: true } })) throw dupCode();
  if (body.person_in_charge) await assertPic(body.person_in_charge);
  try {
    const row = await db.room.create({ data: body, select: ROOM_SELECT });
    return presentRoom(row);
  } catch (err) {
    if (uniqueViolation(err)?.includes('room_code')) throw dupCode();
    throw err;
  }
}

/** Ruangan hanya boleh dinonaktifkan jika tidak ada alat aktif dan sensor aktif. */
async function assertDeactivatable(tx: Prisma.TransactionClient, roomId: string) {
  const [equipment, sensors] = await Promise.all([
    tx.equipment.count({ where: { room_id: roomId, is_active: true } }),
    tx.sensor.count({ where: { room_id: roomId, is_active: true } }),
  ]);
  if (equipment > 0 || sensors > 0) {
    throw new AppError(409, 'ROOM_NOT_EMPTY', 'Ruangan masih memiliki alat atau sensor aktif', {
      active_equipment: equipment,
      active_sensors: sensors,
    });
  }
}

export async function update(id: string, body: UpdateRoomBody) {
  const db = getDb();
  if (body.person_in_charge) await assertPic(body.person_in_charge);
  try {
    return await db.$transaction(async (tx) => {
      const cur = await tx.room.findUnique({
        where: { room_id: id },
        select: { room_id: true, room_code: true, equipment_capacity: true, is_active: true },
      });
      if (!cur) throw AppError.notFound('Ruangan tidak ditemukan');

      if (body.room_code && body.room_code !== cur.room_code) {
        if (await tx.room.findUnique({ where: { room_code: body.room_code }, select: { room_id: true } })) throw dupCode();
      }

      const warnings: CapacityWarning[] = [];
      if (body.equipment_capacity !== undefined && body.equipment_capacity !== cur.equipment_capacity) {
        await lockRooms(tx, [id]);
        const w = await assertRoomCapacity(tx, { ...cur, equipment_capacity: body.equipment_capacity }, 0);
        if (w) warnings.push(w);
      }
      if (body.is_active === false && cur.is_active) {
        await lockRooms(tx, [id]);
        await assertDeactivatable(tx, id);
      }

      const row = await tx.room.update({ where: { room_id: id }, data: body, select: ROOM_SELECT });
      return { ...presentRoom(row), ...(warnings.length ? { warnings } : {}) };
    });
  } catch (err) {
    if (uniqueViolation(err)?.includes('room_code')) throw dupCode();
    throw err;
  }
}

/** Soft delete. Ditolak (409) jika masih ada alat/sensor aktif. */
export async function remove(id: string) {
  return getDb().$transaction(async (tx) => {
    const cur = await tx.room.findUnique({ where: { room_id: id }, select: { room_id: true, is_active: true } });
    if (!cur) throw AppError.notFound('Ruangan tidak ditemukan');
    if (cur.is_active) {
      await lockRooms(tx, [id]);
      await assertDeactivatable(tx, id);
    }
    const row = await tx.room.update({ where: { room_id: id }, data: { is_active: false }, select: ROOM_SELECT });
    return presentRoom(row);
  });
}

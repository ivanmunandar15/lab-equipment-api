import type { Prisma } from '@prisma/client';
import { env } from '../../config/env';
import { AppError } from '../../utils/errors';

type Tx = Prisma.TransactionClient;

export interface RoomLite {
  room_id: string;
  room_code: string;
  equipment_capacity: number;
}

export interface CapacityWarning {
  code: 'ROOM_CAPACITY_EXCEEDED';
  message: string;
  room_id: string;
  room_code: string;
  capacity: number;
  used: number;
  incoming: number;
}

/** equipment_capacity = 0 berarti tidak dibatasi. */
export function capacityInfo(capacity: number, used: number) {
  const limited = capacity > 0;
  return {
    total: capacity,
    used,
    remaining: limited ? Math.max(capacity - used, 0) : null,
    usage_percent: limited ? Math.round((used / capacity) * 1000) / 10 : null,
    is_unlimited: !limited,
    is_over_capacity: limited && used > capacity,
  };
}

/** Kunci baris ruangan (urut by id agar tidak deadlock) supaya pengecekan kapasitas aman dari race condition. */
export async function lockRooms(tx: Tx, roomIds: string[]): Promise<void> {
  for (const id of [...new Set(roomIds)].sort()) {
    await tx.$queryRaw`SELECT room_id FROM rooms WHERE room_id = ${id}::uuid FOR UPDATE`;
  }
}

export const countActiveEquipment = (tx: Pick<Tx, 'equipment'>, roomId: string) =>
  tx.equipment.count({ where: { room_id: roomId, is_active: true } });

export function buildCapacityWarning(room: RoomLite, used: number, incoming: number): CapacityWarning {
  return {
    code: 'ROOM_CAPACITY_EXCEEDED',
    message: `Kapasitas ruangan ${room.room_code} terlampaui: kapasitas ${room.equipment_capacity}, terpakai ${used}${incoming ? `, akan ditambah ${incoming}` : ''}`,
    room_id: room.room_id,
    room_code: room.room_code,
    capacity: room.equipment_capacity,
    used,
    incoming,
  };
}

/**
 * Cek apakah `incoming` alat aktif tambahan masih muat di ruangan.
 * Mode `block` (env ROOM_CAPACITY_MODE) melempar 409; mode `warn` mengembalikan peringatan.
 * Panggil di dalam transaksi setelah lockRooms.
 */
export async function assertRoomCapacity(tx: Tx, room: RoomLite, incoming: number): Promise<CapacityWarning | null> {
  if (room.equipment_capacity <= 0) return null;
  const used = await countActiveEquipment(tx, room.room_id);
  if (used + incoming <= room.equipment_capacity) return null;
  const warning = buildCapacityWarning(room, used, incoming);
  if (env.ROOM_CAPACITY_MODE === 'block') {
    throw new AppError(409, warning.code, warning.message, {
      room_id: warning.room_id,
      room_code: warning.room_code,
      capacity: warning.capacity,
      used,
      incoming,
    });
  }
  return warning;
}

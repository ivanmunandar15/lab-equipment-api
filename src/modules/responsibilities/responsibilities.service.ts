import { getDb } from '../../config/db';
import { AppError } from '../../utils/errors';
import type { CreateResponsibilityBody } from './responsibilities.schema';
import { normalizeCode, ruleMatches } from './responsibility.match';

const RULE_SELECT = {
  responsibility_id: true,
  user_id: true,
  code_prefix: true,
  room_id: true,
  created_at: true,
  user: { select: { user_id: true, name: true, email: true, role: true, is_active: true, email_notifications: true } },
  room: { select: { room_id: true, room_code: true, room_name: true } },
} as const;

const SAMPLE_LIMIT = 10;

/** Alat aktif (untuk menghitung cakupan aturan). */
const loadEquipment = () =>
  getDb().equipment.findMany({
    where: { is_active: true },
    select: { inventory_code: true, room_id: true, next_calibration_date: true },
  });

/**
 * Semua aturan (+ jumlah alat aktif yang cocok per aturan) dan cakupan: dari alat yang punya jadwal kalibrasi,
 * berapa yang punya penanggung jawab (aturan atau PIC ruangan) dan contoh yang belum (TIDAK akan menerima email).
 */
export async function list() {
  const db = getDb();
  const [rules, equipment, rooms] = await Promise.all([
    db.equipmentResponsibility.findMany({ select: RULE_SELECT, orderBy: { created_at: 'asc' } }),
    loadEquipment(),
    db.room.findMany({ select: { room_id: true, person_in_charge: true } }),
  ]);
  const picByRoom = new Map(rooms.map((r) => [r.room_id, r.person_in_charge]));

  const items = rules
    .map((r) => ({ ...r, equipment_count: equipment.filter((e) => ruleMatches(r, e)).length }))
    .sort((a, b) => a.user.name.localeCompare(b.user.name, 'id') || (a.code_prefix ?? '').localeCompare(b.code_prefix ?? ''));

  const scheduled = equipment.filter((e) => e.next_calibration_date);
  const unassigned = scheduled.filter((e) => !rules.some((r) => ruleMatches(r, e)) && !(e.room_id && picByRoom.get(e.room_id)));
  return {
    rules: items,
    coverage: {
      scheduled_equipment: scheduled.length,
      assigned: scheduled.length - unassigned.length,
      unassigned: unassigned.length,
      unassigned_sample: unassigned.slice(0, SAMPLE_LIMIT).map((e) => e.inventory_code),
    },
  };
}

export async function create(input: CreateResponsibilityBody) {
  const db = getDb();
  const prefix = input.code_prefix ? normalizeCode(input.code_prefix) : null;
  const roomId = input.room_id ?? null;
  if (!prefix && !roomId) throw AppError.unprocessable('Isi awalan kode inventaris dan/atau ruangan', [{ field: 'code_prefix', message: 'Isi awalan kode inventaris dan/atau ruangan' }]);

  const user = await db.user.findUnique({ where: { user_id: input.user_id }, select: { user_id: true, is_active: true } });
  if (!user) throw AppError.unprocessable('Pengguna tidak ditemukan', [{ field: 'user_id', message: 'Pengguna tidak ditemukan' }]);
  if (!user.is_active) throw AppError.unprocessable('Pengguna nonaktif', [{ field: 'user_id', message: 'Pengguna nonaktif tidak bisa menjadi penanggung jawab' }]);
  if (roomId && !(await db.room.findUnique({ where: { room_id: roomId }, select: { room_id: true } }))) {
    throw AppError.unprocessable('Ruangan tidak ditemukan', [{ field: 'room_id', message: 'Ruangan tidak ditemukan' }]);
  }

  // NULL dianggap berbeda oleh unique index PostgreSQL, jadi duplikat dicek di sini.
  const dup = await db.equipmentResponsibility.findFirst({ where: { user_id: input.user_id, code_prefix: prefix, room_id: roomId }, select: { responsibility_id: true } });
  if (dup) throw AppError.conflict('Aturan yang sama sudah ada untuk pengguna ini');

  const row = await db.equipmentResponsibility.create({
    data: { user_id: input.user_id, code_prefix: prefix, room_id: roomId },
    select: RULE_SELECT,
  });
  const equipment = await loadEquipment();
  return { ...row, equipment_count: equipment.filter((e) => ruleMatches(row, e)).length };
}

export async function remove(id: string) {
  const db = getDb();
  const row = await db.equipmentResponsibility.findUnique({ where: { responsibility_id: id }, select: { responsibility_id: true } });
  if (!row) throw AppError.notFound('Aturan tidak ditemukan');
  await db.equipmentResponsibility.delete({ where: { responsibility_id: id } });
  return { deleted: true };
}

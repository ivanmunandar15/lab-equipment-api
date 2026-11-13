import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import { getDb } from '../../config/db';
import { AppError } from '../../utils/errors';
import { authorize } from '../../middlewares/rbac';
import { PERMISSIONS } from '../../config/permissions';
import { AUDIT_ACTIONS, AUDIT_ENTITIES } from '../activity-logs/audit.service';
import * as rooms from '../rooms/rooms.service';
import * as users from '../users/users.service';
import { diffFields, log } from './compat.audit';
import { LIST_CAP, emptyToNull, flag, h, idParam, isUuid, parse, send, str } from './compat.http';
import { toRoom, toUser } from './compat.mappers';
import { createRoomSchema, createUserSchema, updateRoomSchema, updateUserSchema } from './compat.schemas';

const U = AUDIT_ENTITIES.USER;
const R = AUDIT_ENTITIES.ROOM;

/* =========================== USERS =========================== */

const USER_SELECT = { user_id: true, name: true, email: true, role: true, is_active: true, created_at: true, updated_at: true } as const;
const adminOnly = authorize(...PERMISSIONS.users.manage);

const insensitive = (v: string): Prisma.StringFilter => ({ contains: v, mode: 'insensitive' });

async function findUser(id: string) {
  const row = await getDb().user.findUnique({ where: { user_id: id }, select: USER_SELECT });
  if (!row) throw AppError.notFound(`Pengguna dengan ID "${id}" tidak ditemukan`);
  return row;
}

/** Admin terakhir tidak boleh dinonaktifkan / diturunkan perannya (aturan mock). */
async function assertNotLastAdmin(target: { role: string; is_active: boolean }) {
  if (target.role !== 'admin' || !target.is_active) return;
  const admins = await getDb().user.count({ where: { role: 'admin', is_active: true } });
  if (admins <= 1) throw AppError.conflict('Tidak dapat menonaktifkan atau mengubah peran admin terakhir');
}

/**
 * Direktori pengguna dibaca semua role (UI menampilkan nama peminjam/teknisi/pengunggah).
 * Email hanya untuk admin; role lain menerima email kosong.
 */
const view = (req: { user?: { role: string } }, u: Parameters<typeof toUser>[0]) => {
  const out = toUser(u);
  return req.user?.role === 'admin' ? out : { ...out, email: '' };
};

export const usersRouter = Router();

usersRouter.get('/', h(async (req, res) => {
  const search = str(req.query.search);
  const role = str(req.query.role);
  const rows = await getDb().user.findMany({
    where: {
      ...(flag(req.query.includeInactive) ? {} : { is_active: true }),
      ...(role ? { role: role as never } : {}),
      ...(search ? { OR: [{ name: insensitive(search) }, { email: insensitive(search) }] } : {}),
    },
    orderBy: { name: 'asc' },
    take: LIST_CAP,
    select: USER_SELECT,
  });
  send(res, rows.map((u) => view(req, u)));
}));

usersRouter.get('/:id', h(async (req, res) => {
  send(res, view(req, await findUser(idParam(req, 'id', 'Pengguna'))));
}));

usersRouter.post('/', adminOnly, h(async (req, res) => {
  const data = parse(createUserSchema, req.body);
  const { user } = await users.create({ name: data.name, email: data.email, role: data.role, password: data.password });
  await log(req, { action: AUDIT_ACTIONS.CREATE, entityType: U, entityId: user.user_id, newData: { name: user.name, role: user.role } });
  send(res, toUser(user), 201);
}));

usersRouter.patch('/:id', adminOnly, h(async (req, res) => {
  const id = idParam(req, 'id', 'Pengguna');
  const patch = parse(updateUserSchema, req.body);
  const before = await findUser(id);
  if (patch.email && patch.email !== before.email) {
    const taken = await getDb().user.findUnique({ where: { email: patch.email }, select: { user_id: true } });
    if (taken && taken.user_id !== id) throw AppError.conflict('Email sudah digunakan');
  }
  if ((patch.role && patch.role !== 'admin') || patch.is_active === false) await assertNotLastAdmin(before);

  const { email, ...rest } = patch;
  if (email && email !== before.email) await getDb().user.update({ where: { user_id: id }, data: { email } });
  if (Object.keys(rest).length) await users.update(id, rest, req.user!.user_id);
  const after = await findUser(id);
  const { oldData, newData } = diffFields(toUser(before), toUser(after));
  await log(req, { action: AUDIT_ACTIONS.UPDATE, entityType: U, entityId: id, oldData, newData });
  send(res, toUser(after));
}));

usersRouter.delete('/:id', adminOnly, h(async (req, res) => {
  const id = idParam(req, 'id', 'Pengguna');
  const before = await findUser(id);
  await assertNotLastAdmin(before);
  await users.deactivate(id, req.user!.user_id);
  await log(req, { action: AUDIT_ACTIONS.DELETE, entityType: U, entityId: id, oldData: { is_active: true }, newData: { is_active: false } });
  send(res, toUser(await findUser(id)));
}));

usersRouter.post('/:id/restore', adminOnly, h(async (req, res) => {
  const id = idParam(req, 'id', 'Pengguna');
  await findUser(id);
  await users.update(id, { is_active: true }, req.user!.user_id);
  await log(req, { action: AUDIT_ACTIONS.UPDATE, entityType: U, entityId: id, oldData: { is_active: false }, newData: { is_active: true } });
  send(res, toUser(await findUser(id)));
}));

/* =========================== ROOMS =========================== */

const ROOM_SELECT = { room_id: true, room_code: true, room_name: true, equipment_capacity: true, person_in_charge: true, description: true, created_at: true, updated_at: true } as const;
const roomWrite = authorize(...PERMISSIONS.rooms.write);

async function findRoom(id: string) {
  const row = await getDb().room.findUnique({ where: { room_id: id }, select: ROOM_SELECT });
  if (!row) throw AppError.notFound(`Ruangan dengan ID "${id}" tidak ditemukan`);
  return row;
}

/** person_in_charge adalah FK user: "" = tanpa penanggung jawab (null); nilai bukan UUID dilaporkan sebagai error field, bukan 500. */
function picOrThrow(v: string | undefined): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === '') return null;
  if (!isUuid(v)) throw AppError.unprocessable('Validasi gagal', [{ path: 'person_in_charge', message: 'Penanggung jawab tidak valid' }]);
  return v;
}

export const roomsRouter = Router();

roomsRouter.get('/', h(async (req, res) => {
  const search = str(req.query.search);
  const rows = await getDb().room.findMany({
    where: {
      is_active: true,
      ...(search ? { OR: [{ room_name: insensitive(search) }, { room_code: insensitive(search) }, { description: insensitive(search) }] } : {}),
    },
    orderBy: { room_code: 'asc' },
    take: LIST_CAP,
    select: ROOM_SELECT,
  });
  send(res, rows.map(toRoom));
}));

roomsRouter.get('/:id', h(async (req, res) => send(res, toRoom(await findRoom(idParam(req, 'id', 'Ruangan'))))));

roomsRouter.post('/', roomWrite, h(async (req, res) => {
  const data = parse(createRoomSchema, req.body);
  const created = await rooms.create({
    room_code: data.room_code, room_name: data.room_name, equipment_capacity: data.equipment_capacity,
    person_in_charge: picOrThrow(data.person_in_charge) ?? null, description: emptyToNull(data.description) ?? null,
  });
  await log(req, { action: AUDIT_ACTIONS.CREATE, entityType: R, entityId: created.room_id, newData: { room_code: created.room_code, room_name: created.room_name } });
  send(res, toRoom(created), 201);
}));

roomsRouter.patch('/:id', roomWrite, h(async (req, res) => {
  const id = idParam(req, 'id', 'Ruangan');
  const patch = parse(updateRoomSchema, req.body);
  const before = await findRoom(id);
  const updated = await rooms.update(id, {
    ...(patch.room_code !== undefined ? { room_code: patch.room_code } : {}),
    ...(patch.room_name !== undefined ? { room_name: patch.room_name } : {}),
    ...(patch.equipment_capacity !== undefined ? { equipment_capacity: patch.equipment_capacity } : {}),
    ...(patch.person_in_charge !== undefined ? { person_in_charge: picOrThrow(patch.person_in_charge) } : {}),
    ...(patch.description !== undefined ? { description: emptyToNull(patch.description) } : {}),
  });
  const { oldData, newData } = diffFields(toRoom(before), toRoom(updated));
  await log(req, { action: AUDIT_ACTIONS.UPDATE, entityType: R, entityId: id, oldData, newData });
  send(res, toRoom(updated));
}));

/** Soft delete di backend (ditolak 409 bila masih ada alat/sensor aktif). Respons 204 seperti `Promise<void>` di mock. */
roomsRouter.delete('/:id', roomWrite, h(async (req, res) => {
  const id = idParam(req, 'id', 'Ruangan');
  const before = await findRoom(id);
  await rooms.remove(id);
  await log(req, { action: AUDIT_ACTIONS.DELETE, entityType: R, entityId: id, oldData: { room_code: before.room_code } });
  res.status(204).end();
}));

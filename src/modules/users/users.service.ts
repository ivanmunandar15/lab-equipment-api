import type { Prisma } from '@prisma/client';
import { getDb } from '../../config/db';
import { AppError } from '../../utils/errors';
import { buildMeta, getPagination, resolveSort } from '../../utils/pagination';
import { generateTempPassword, hashPassword } from '../../utils/password';
import { USER_PUBLIC_SELECT } from './users.select';
import type { CreateUserBody, ListUsersQuery, UpdateUserBody } from './users.schema';

const SORTABLE = ['name', 'email', 'role', 'is_active', 'created_at', 'updated_at'];

export async function list(q: ListUsersQuery) {
  const db = getDb();
  const where: Prisma.UserWhereInput = {
    ...(q.role ? { role: q.role } : {}),
    ...(q.is_active !== undefined ? { is_active: q.is_active } : {}),
    ...(q.search
      ? {
          OR: [
            { name: { contains: q.search, mode: 'insensitive' } },
            { email: { contains: q.search, mode: 'insensitive' } },
          ],
        }
      : {}),
  };
  const { page, limit, skip, take } = getPagination(q);
  const sortField = resolveSort(q.sort, SORTABLE, 'created_at');
  const [items, total] = await Promise.all([
    db.user.findMany({ where, orderBy: { [sortField]: q.order }, skip, take, select: USER_PUBLIC_SELECT }),
    db.user.count({ where }),
  ]);
  return { items, meta: buildMeta(page, limit, total) };
}

export async function getById(id: string) {
  const user = await getDb().user.findUnique({ where: { user_id: id }, select: USER_PUBLIC_SELECT });
  if (!user) throw AppError.notFound('User tidak ditemukan');
  return user;
}

export async function create(body: CreateUserBody) {
  const db = getDb();
  const exists = await db.user.findUnique({ where: { email: body.email }, select: { user_id: true } });
  if (exists) throw AppError.conflict('Email sudah terdaftar');

  const temporary_password = body.password ? undefined : generateTempPassword();
  const password_hash = await hashPassword(body.password ?? (temporary_password as string));
  const user = await db.user.create({
    data: { name: body.name, email: body.email, role: body.role, password_hash },
    select: USER_PUBLIC_SELECT,
  });
  return { user, temporary_password };
}

export async function update(id: string, body: UpdateUserBody, actorId: string) {
  const db = getDb();
  const target = await getById(id);

  if (id === actorId && body.is_active === false) {
    throw new AppError(400, 'SELF_DEACTIVATION', 'Anda tidak dapat menonaktifkan akun sendiri');
  }
  if (id === actorId && body.role && body.role !== target.role) {
    throw new AppError(400, 'SELF_ROLE_CHANGE', 'Anda tidak dapat mengubah role akun sendiri');
  }

  return db.$transaction(async (tx) => {
    const user = await tx.user.update({ where: { user_id: id }, data: body, select: USER_PUBLIC_SELECT });
    if (body.is_active === false) {
      await tx.refreshToken.updateMany({
        where: { user_id: id, revoked_at: null },
        data: { revoked_at: new Date() },
      });
    }
    return user;
  });
}

export async function resetPassword(id: string, newPassword: string | undefined) {
  const db = getDb();
  await getById(id);
  const temporary_password = newPassword ? undefined : generateTempPassword();
  const password_hash = await hashPassword(newPassword ?? (temporary_password as string));

  await db.$transaction(async (tx) => {
    await tx.user.update({ where: { user_id: id }, data: { password_hash } });
    await tx.refreshToken.updateMany({
      where: { user_id: id, revoked_at: null },
      data: { revoked_at: new Date() },
    });
  });
  return { temporary_password };
}

/** Soft delete: is_active = false dan cabut semua refresh token. */
export async function deactivate(id: string, actorId: string) {
  if (id === actorId) {
    throw new AppError(400, 'SELF_DEACTIVATION', 'Anda tidak dapat menonaktifkan akun sendiri');
  }
  return update(id, { is_active: false }, actorId);
}

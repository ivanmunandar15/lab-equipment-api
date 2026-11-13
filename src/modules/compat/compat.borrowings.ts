import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import { getDb } from '../../config/db';
import { AppError } from '../../utils/errors';
import { AUDIT_ACTIONS, AUDIT_ENTITIES } from '../activity-logs/audit.service';
import * as borrowings from '../borrowings/borrowings.service';
import { actorOf, log } from './compat.audit';
import { LIST_CAP, h, idParam, isUuid, parse, send, str } from './compat.http';
import { parseCondition, toBorrowingWithDetails } from './compat.mappers';
import { createBorrowingSchema, returnBorrowingSchema, updateBorrowingSchema } from './compat.schemas';

const B = AUDIT_ENTITIES.BORROWING;
const insensitive = (v: string): Prisma.StringFilter => ({ contains: v, mode: 'insensitive' });
const invalid = (path: string, message: string) => AppError.unprocessable('Validasi gagal', [{ path, message }]);

async function load(id: string) {
  const db = getDb();
  const b = await db.borrowing.findUnique({ where: { borrowing_id: id } });
  if (!b) throw AppError.notFound(`Peminjaman dengan ID "${id}" tidak ditemukan`);
  const [eq, sp] = await Promise.all([
    db.borrowingDetail.findMany({ where: { borrowing_id: id } }),
    db.supportingBorrowingDetail.findMany({ where: { borrowing_id: id } }),
  ]);
  return toBorrowingWithDetails(b, eq, sp);
}

export const borrowingsRouter = Router();

borrowingsRouter.get('/', h(async (req, res) => {
  const db = getDb();
  const now = new Date();
  const status = str(req.query.status);
  const userId = str(req.query.user_id);
  const eqId = str(req.query.equipment_id);
  const spId = str(req.query.supporting_equipment_id);
  const search = str(req.query.search);
  if ((userId && !isUuid(userId)) || (eqId && !isUuid(eqId)) || (spId && !isUuid(spId))) return send(res, []);

  const rows = await db.borrowing.findMany({
    where: {
      ...(userId ? { user_id: userId } : {}),
      ...(status === 'borrowed' ? { borrowing_status: 'borrowed' } : {}),
      ...(status === 'returned' ? { borrowing_status: 'returned' } : {}),
      ...(status === 'overdue' ? { borrowing_status: 'borrowed', expected_return_time: { lt: now } } : {}),
      ...(eqId ? { details: { some: { equipment_id: eqId } } } : {}),
      ...(spId ? { supporting_details: { some: { supporting_equipment_id: spId } } } : {}),
      ...(search ? { OR: [{ purpose: insensitive(search) }, { usage_location: insensitive(search) }, { user: { name: insensitive(search) } }] } : {}),
    },
    orderBy: { borrowing_time: 'desc' },
    take: LIST_CAP,
  });
  const ids = rows.map((r) => r.borrowing_id);
  const [eq, sp] = ids.length
    ? await Promise.all([
        db.borrowingDetail.findMany({ where: { borrowing_id: { in: ids } } }),
        db.supportingBorrowingDetail.findMany({ where: { borrowing_id: { in: ids } } }),
      ])
    : [[], []];
  send(res, rows.map((b) => toBorrowingWithDetails(b, eq.filter((d) => d.borrowing_id === b.borrowing_id), sp.filter((d) => d.borrowing_id === b.borrowing_id), now)));
}));

borrowingsRouter.get('/:id', h(async (req, res) => send(res, await load(idParam(req, 'id', 'Peminjaman')))));

borrowingsRouter.post('/', h(async (req, res) => {
  const d = parse(createBorrowingSchema, req.body);
  const actor = actorOf(req);
  if (d.user_id !== actor.userId) throw AppError.forbidden('Peminjaman hanya dapat dibuat atas nama pengguna yang sedang login');
  if (Date.parse(d.expected_return_time) <= Date.now()) throw invalid('expected_return_time', 'Waktu pengembalian harus setelah waktu peminjaman');

  const equipmentIds = [...new Set(d.equipment_ids)];
  const merged = new Map<string, number>();
  for (const l of d.supporting_items) merged.set(l.supporting_equipment_id, (merged.get(l.supporting_equipment_id) ?? 0) + l.quantity);
  if (equipmentIds.some((i) => !isUuid(i))) throw AppError.notFound('Alat tidak ditemukan');
  if ([...merged.keys()].some((i) => !isUuid(i))) throw AppError.notFound('Alat pendukung tidak ditemukan');

  try {
    const created = await borrowings.create(
      {
        purpose: d.purpose, usage_location: d.usage_location, expected_return_time: new Date(d.expected_return_time),
        notes: d.notes?.trim() ? d.notes : null,
        equipment: equipmentIds.map((equipment_id) => ({ equipment_id })),
        supporting: [...merged].map(([supporting_equipment_id, quantity]) => ({ supporting_equipment_id, quantity })),
      },
      actor,
    );
    send(res, await load(created.borrowing_id), 201);
  } catch (err) {
    // Pesan konflik per item (mis. "Oven A tidak tersedia") agar toast frontend informatif.
    if (err instanceof AppError && err.code === 'BORROWING_CONFLICT') {
      const items = ((err.details as { items?: { name?: string; code?: string; message: string }[] })?.items ?? []);
      const msg = items.map((i) => `${i.name ?? i.code ?? 'Item'}: ${i.message}`).join('; ');
      throw new AppError(409, err.code, msg || err.message, err.details);
    }
    throw err;
  }
}));

/** Hanya metadata (batas waktu, tujuan, lokasi, catatan) yang dapat diubah selama masih dipinjam. */
borrowingsRouter.patch('/:id', h(async (req, res) => {
  const id = idParam(req, 'id', 'Peminjaman');
  const patch = parse(updateBorrowingSchema, req.body);
  const db = getDb();
  const b = await db.borrowing.findUnique({ where: { borrowing_id: id } });
  if (!b) throw AppError.notFound(`Peminjaman dengan ID "${id}" tidak ditemukan`);
  if (b.user_id !== req.user!.user_id && !['admin', 'SPV'].includes(req.user!.role)) throw AppError.forbidden('Hanya peminjam, admin, atau SPV yang dapat mengubah peminjaman');
  if (b.borrowing_status === 'returned') throw AppError.conflict('Peminjaman yang sudah dikembalikan tidak dapat diubah');
  if (patch.expected_return_time && Date.parse(patch.expected_return_time) <= b.borrowing_time.getTime()) {
    throw AppError.conflict('Waktu pengembalian harus setelah waktu peminjaman');
  }
  await db.borrowing.update({
    where: { borrowing_id: id },
    data: {
      ...(patch.expected_return_time ? { expected_return_time: new Date(patch.expected_return_time) } : {}),
      ...(patch.purpose !== undefined ? { purpose: patch.purpose } : {}),
      ...(patch.usage_location !== undefined ? { usage_location: patch.usage_location } : {}),
      ...(patch.notes !== undefined ? { notes: patch.notes.trim() ? patch.notes : null } : {}),
    },
  });
  await log(req, { action: AUDIT_ACTIONS.UPDATE, entityType: B, entityId: id, newData: patch });
  send(res, await load(id));
}));

/**
 * Pengembalian sebagian diperbolehkan. Kondisi akhir diambil dari `new_condition` (enum) atau label di `final_condition`.
 * Kebijakan rusak = 'major_only' (kontrak frontend): hanya rusak berat yang membuat alat berstatus damaged.
 */
borrowingsRouter.post('/:id/return', h(async (req, res) => {
  const id = idParam(req, 'id', 'Peminjaman');
  const d = parse(returnBorrowingSchema, req.body);
  const cond = (l: { new_condition?: 'good' | 'minor_damage' | 'major_damage'; final_condition: string; has_damage: boolean }) => {
    const c = l.new_condition ?? parseCondition(l.final_condition) ?? (l.has_damage ? 'minor_damage' : 'good');
    return l.has_damage && c === 'good' ? ('minor_damage' as const) : c;
  };
  const items = d.equipment.map((l) => {
    const c = cond(l);
    return { detail_id: l.detail_id, final_condition: c, has_damage: l.has_damage, damage_notes: l.has_damage ? (l.damage_notes ?? null) : null };
  });
  const supportingLines = d.supporting
    .filter((l) => l.quantity_returned_now > 0)
    .map((l) => ({
      supporting_detail_id: l.supporting_detail_id, quantity_returned: l.quantity_returned_now, final_condition: cond(l),
      has_damage: l.has_damage, damage_notes: l.has_damage ? (l.damage_notes ?? null) : null,
    }));
  if (!items.length && !supportingLines.length) throw invalid('lines', 'Isi jumlah yang dikembalikan minimal 1');
  if ([...items.map((i) => i.detail_id), ...supportingLines.map((i) => i.supporting_detail_id)].some((x) => !isUuid(x))) {
    throw AppError.notFound('Detail peminjaman tidak ditemukan');
  }

  try {
    await borrowings.returnItems(id, { items, supporting: supportingLines }, actorOf(req), { damageStatus: 'major_only' });
  } catch (err) {
    if (err instanceof AppError && err.code === 'RETURN_CONFLICT') {
      const list = ((err.details as { items?: { message: string }[] })?.items ?? []).map((i) => i.message).join('; ');
      throw new AppError(409, err.code, list || err.message, err.details);
    }
    throw err;
  }
  if (d.notes?.trim()) await getDb().borrowing.update({ where: { borrowing_id: id }, data: { notes: d.notes } });
  send(res, await load(id));
}));

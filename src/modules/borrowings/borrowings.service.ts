import type { ItemCondition, Prisma } from '@prisma/client';
import { getDb } from '../../config/db';
import { env } from '../../config/env';
import { PERMISSIONS, type RoleName } from '../../config/permissions';
import { AppError } from '../../utils/errors';
import { buildMeta, getPagination, resolveSort } from '../../utils/pagination';
import { AUDIT_ACTIONS, AUDIT_ENTITIES, audit } from '../activity-logs/audit.service';
import { calibrationState, dateOnly } from '../equipment/equipment.derive';
import { DAMAGE_RECIPIENT_ROLES, notifyRoles } from '../notifications/notify.service';
import { assertQuantities, deriveSupportingStatus } from '../supporting-equipment/supporting-equipment.derive';
import type { CreateBorrowingBody, ListBorrowingsQuery, ReturnBorrowingBody } from './borrowings.schema';

type Tx = Prisma.TransactionClient;

export interface Actor {
  userId: string;
  role: RoleName;
  ip: string | null;
}

const DAY_MS = 86_400_000;
const SORTABLE = ['borrowing_time', 'expected_return_time', 'actual_return_time', 'created_at'];
const RANK: Record<ItemCondition, number> = { good: 0, minor_damage: 1, major_damage: 2 };

export interface Problem {
  type: 'equipment' | 'supporting';
  index: number;
  equipment_id?: string;
  supporting_equipment_id?: string;
  qr_token?: string;
  code?: string;
  name?: string;
  reason: string;
  message: string;
  status?: string;
  requested?: number;
  available?: number;
}

// ───────── penguncian baris (SELECT ... FOR UPDATE, urut id → tidak deadlock) ─────────

const lockEquipment = async (tx: Tx, ids: string[]) => {
  if (ids.length) await tx.$queryRaw`SELECT equipment_id FROM equipment WHERE equipment_id = ANY(${ids}::uuid[]) ORDER BY equipment_id FOR UPDATE`;
};
const lockSupporting = async (tx: Tx, ids: string[]) => {
  if (ids.length) {
    await tx.$queryRaw`SELECT supporting_equipment_id FROM supporting_equipment WHERE supporting_equipment_id = ANY(${ids}::uuid[]) ORDER BY supporting_equipment_id FOR UPDATE`;
  }
};
const lockBorrowing = async (tx: Tx, id: string) => {
  await tx.$queryRaw`SELECT borrowing_id FROM borrowings WHERE borrowing_id = ${id}::uuid FOR UPDATE`;
};

const EQ_SELECT = {
  equipment_id: true, inventory_code: true, equipment_name: true, qr_token: true,
  status: true, condition: true, is_active: true, next_calibration_date: true,
} satisfies Prisma.EquipmentSelect;
const SP_SELECT = {
  supporting_equipment_id: true, item_code: true, item_name: true, qr_token: true, unit: true,
  total_quantity: true, available_quantity: true, condition: true, status: true, is_active: true,
} satisfies Prisma.SupportingEquipmentSelect;

const uniq = <T>(a: T[]) => [...new Set(a)];
const conflict = (message: string, code: string, items: Problem[]) => new AppError(409, code, message, { items });

// ───────── detail lengkap ─────────

const isOverdue = (status: string, expected: Date, now = Date.now()) => status === 'borrowed' && expected.getTime() < now;

export async function loadDetail(tx: Tx, id: string) {
  const b = await tx.borrowing.findUnique({ where: { borrowing_id: id } });
  if (!b) return null;
  const [user, eqDetails, spDetails] = await Promise.all([
    tx.user.findUnique({ where: { user_id: b.user_id }, select: { user_id: true, name: true, email: true, role: true } }),
    tx.borrowingDetail.findMany({ where: { borrowing_id: id } }),
    tx.supportingBorrowingDetail.findMany({ where: { borrowing_id: id } }),
  ]);
  const equipment = eqDetails.length
    ? await tx.equipment.findMany({
        where: { equipment_id: { in: eqDetails.map((d) => d.equipment_id) } },
        select: { equipment_id: true, inventory_code: true, equipment_name: true, equipment_type: true, qr_token: true, status: true, condition: true },
      })
    : [];
  const supporting = spDetails.length
    ? await tx.supportingEquipment.findMany({
        where: { supporting_equipment_id: { in: spDetails.map((d) => d.supporting_equipment_id) } },
        select: { supporting_equipment_id: true, item_code: true, item_name: true, unit: true, qr_token: true, status: true, condition: true },
      })
    : [];
  const eqMap = new Map(equipment.map((e) => [e.equipment_id, e]));
  const spMap = new Map(supporting.map((e) => [e.supporting_equipment_id, e]));

  // Alat dianggap sudah kembali jika final_condition terisi.
  const eqItems = eqDetails.map((d) => ({
    detail_id: d.detail_id,
    equipment: eqMap.get(d.equipment_id) ?? null,
    initial_condition: d.initial_condition,
    final_condition: d.final_condition,
    has_damage: d.has_damage,
    damage_notes: d.damage_notes,
    is_returned: d.final_condition !== null,
  }));
  const spItems = spDetails.map((d) => ({
    supporting_detail_id: d.supporting_detail_id,
    item: spMap.get(d.supporting_equipment_id) ?? null,
    quantity_borrowed: d.quantity_borrowed,
    quantity_returned: d.quantity_returned,
    quantity_outstanding: Math.max(d.quantity_borrowed - d.quantity_returned, 0),
    initial_condition: d.initial_condition,
    final_condition: d.final_condition,
    has_damage: d.has_damage,
    damage_notes: d.damage_notes,
    is_returned: d.quantity_returned >= d.quantity_borrowed,
  }));

  return {
    ...b,
    is_overdue: isOverdue(b.borrowing_status, b.expected_return_time),
    user,
    summary: {
      equipment_total: eqItems.length,
      equipment_returned: eqItems.filter((i) => i.is_returned).length,
      supporting_total: spItems.length,
      supporting_returned: spItems.filter((i) => i.is_returned).length,
      supporting_units_outstanding: spItems.reduce((s, i) => s + i.quantity_outstanding, 0),
    },
    equipment: eqItems,
    supporting: spItems,
  };
}

export const canReturn = (b: { user_id: string; borrowing_status: string }, actor: Pick<Actor, 'userId' | 'role'>) =>
  b.borrowing_status === 'borrowed' && (b.user_id === actor.userId || PERMISSIONS.borrowings.returnAny.includes(actor.role));

export async function getById(id: string, actor: Actor) {
  const d = await loadDetail(getDb(), id);
  if (!d) throw AppError.notFound('Peminjaman tidak ditemukan');
  return { ...d, can_return: canReturn(d, actor) };
}

// ───────── daftar ─────────

export async function list(q: Omit<ListBorrowingsQuery, 'user_id'> & { user_id?: string }, forcedUserId?: string) {
  const db = getDb();
  const now = new Date();
  const userId = forcedUserId ?? q.user_id;
  const where: Prisma.BorrowingWhereInput = {
    ...(userId ? { user_id: userId } : {}),
    // overdue tidak disimpan: dihitung dari expected_return_time < sekarang dan status = borrowed
    ...(q.status === 'active' ? { borrowing_status: 'borrowed' } : {}),
    ...(q.status === 'overdue' ? { borrowing_status: 'borrowed', expected_return_time: { lt: now } } : {}),
    ...(q.status === 'returned' ? { borrowing_status: 'returned' } : {}),
    ...(q.equipment_id ? { details: { some: { equipment_id: q.equipment_id } } } : {}),
    ...(q.date_from || q.date_to
      ? {
          borrowing_time: {
            ...(q.date_from ? { gte: q.date_from } : {}),
            ...(q.date_to ? { lt: new Date(q.date_to.getTime() + DAY_MS) } : {}), // date_to inklusif sampai akhir hari UTC
          },
        }
      : {}),
    ...(q.search
      ? { OR: [{ purpose: { contains: q.search, mode: 'insensitive' } }, { usage_location: { contains: q.search, mode: 'insensitive' } }] }
      : {}),
  };
  const sort = resolveSort(q.sort, SORTABLE, 'borrowing_time');
  const { page, limit, skip, take } = getPagination(q);
  const [rows, total] = await Promise.all([
    db.borrowing.findMany({ where, orderBy: [{ [sort]: q.order }, { borrowing_id: 'asc' }], skip, take }),
    db.borrowing.count({ where }),
  ]);

  const ids = rows.map((r) => r.borrowing_id);
  const [users, eq, sp] = rows.length
    ? await Promise.all([
        db.user.findMany({ where: { user_id: { in: uniq(rows.map((r) => r.user_id)) } }, select: { user_id: true, name: true, email: true } }),
        db.borrowingDetail.findMany({ where: { borrowing_id: { in: ids } }, select: { borrowing_id: true } }),
        db.supportingBorrowingDetail.findMany({ where: { borrowing_id: { in: ids } }, select: { borrowing_id: true } }),
      ])
    : [[], [], []];
  const userMap = new Map(users.map((u) => [u.user_id, u]));
  const count = (list: { borrowing_id: string }[], id: string) => list.filter((x) => x.borrowing_id === id).length;

  const items = rows.map((r) => ({
    ...r,
    is_overdue: isOverdue(r.borrowing_status, r.expected_return_time, now.getTime()),
    user: userMap.get(r.user_id) ?? null,
    equipment_count: count(eq, r.borrowing_id),
    supporting_count: count(sp, r.borrowing_id),
  }));
  return { items, meta: buildMeta(page, limit, total) };
}

// ───────── PINJAM ─────────

export async function create(body: CreateBorrowingBody, actor: Actor) {
  return getDb().$transaction(async (tx) => {
    const now = new Date();

    // 1) Resolusi referensi (id atau qr_token) → baris. qr_token immutable, jadi aman dibaca sebelum lock.
    const eqIds = body.equipment.flatMap((r) => (r.equipment_id ? [r.equipment_id] : []));
    const eqTokens = body.equipment.flatMap((r) => (r.qr_token ? [r.qr_token] : []));
    const spIds = body.supporting.flatMap((r) => (r.supporting_equipment_id ? [r.supporting_equipment_id] : []));
    const spTokens = body.supporting.flatMap((r) => (r.qr_token ? [r.qr_token] : []));

    const eqFound = eqIds.length + eqTokens.length
      ? await tx.equipment.findMany({
          where: { OR: [{ equipment_id: { in: eqIds } }, { qr_token: { in: eqTokens } }] },
          select: { equipment_id: true, qr_token: true },
        })
      : [];
    const spFound = spIds.length + spTokens.length
      ? await tx.supportingEquipment.findMany({
          where: { OR: [{ supporting_equipment_id: { in: spIds } }, { qr_token: { in: spTokens } }] },
          select: { supporting_equipment_id: true, qr_token: true },
        })
      : [];
    const eqKey = new Map<string, string>();
    eqFound.forEach((r) => (eqKey.set(r.equipment_id, r.equipment_id), eqKey.set(r.qr_token, r.equipment_id)));
    const spKey = new Map<string, string>();
    spFound.forEach((r) => (spKey.set(r.supporting_equipment_id, r.supporting_equipment_id), spKey.set(r.qr_token, r.supporting_equipment_id)));

    const eqReq = body.equipment.map((ref, index) => ({ ref, index, id: eqKey.get((ref.equipment_id ?? ref.qr_token) as string) }));
    const spReq = body.supporting.map((ref, index) => ({ ref, index, id: spKey.get((ref.supporting_equipment_id ?? ref.qr_token) as string) }));

    const dup: { path: string; message: string }[] = [];
    const seenEq = new Set<string>();
    eqReq.forEach((r) => {
      if (r.id && seenEq.has(r.id)) dup.push({ path: `equipment.${r.index}`, message: 'Alat duplikat dalam satu permintaan' });
      if (r.id) seenEq.add(r.id);
    });
    const seenSp = new Set<string>();
    spReq.forEach((r) => {
      if (r.id && seenSp.has(r.id)) dup.push({ path: `supporting.${r.index}`, message: 'Barang pendukung duplikat; gabungkan jumlahnya' });
      if (r.id) seenSp.add(r.id);
    });
    if (dup.length) throw AppError.unprocessable('Validasi gagal', dup);

    // 2) Kunci baris, lalu BACA ULANG data terbaru (setelah menunggu lock transaksi lain).
    await lockEquipment(tx, [...seenEq]);
    await lockSupporting(tx, [...seenSp]);
    const eqRows = new Map(
      (seenEq.size ? await tx.equipment.findMany({ where: { equipment_id: { in: [...seenEq] } }, select: EQ_SELECT }) : []).map((r) => [r.equipment_id, r]),
    );
    const spRows = new Map(
      (seenSp.size ? await tx.supportingEquipment.findMany({ where: { supporting_equipment_id: { in: [...seenSp] } }, select: SP_SELECT }) : []).map((r) => [
        r.supporting_equipment_id,
        r,
      ]),
    );

    // 3) Validasi semua item; kumpulkan SEMUA masalah (bukan berhenti di yang pertama).
    const problems: Problem[] = [];
    const warnings: { code: 'calibration_overdue'; equipment_id: string; inventory_code: string; next_calibration_date: string | null }[] = [];
    const eqOk: NonNullable<ReturnType<typeof eqRows.get>>[] = [];
    for (const r of eqReq) {
      const row = r.id ? eqRows.get(r.id) : undefined;
      const base = { type: 'equipment' as const, index: r.index, equipment_id: r.ref.equipment_id, qr_token: r.ref.qr_token };
      if (!row) problems.push({ ...base, reason: 'NOT_FOUND', message: 'Alat tidak ditemukan' });
      else if (!row.is_active) problems.push({ ...base, equipment_id: row.equipment_id, code: row.inventory_code, name: row.equipment_name, reason: 'INACTIVE', message: 'Alat sudah dinonaktifkan' });
      else if (row.status !== 'available') {
        problems.push({ ...base, equipment_id: row.equipment_id, code: row.inventory_code, name: row.equipment_name, reason: 'NOT_AVAILABLE', status: row.status, message: `Alat tidak tersedia (status: ${row.status})` });
      } else if (calibrationState(row.next_calibration_date, now) === 'overdue') {
        if (env.CALIBRATION_OVERDUE_POLICY === 'block') {
          problems.push({ ...base, equipment_id: row.equipment_id, code: row.inventory_code, name: row.equipment_name, reason: 'CALIBRATION_OVERDUE', message: 'Kalibrasi alat sudah terlambat' });
        } else {
          warnings.push({ code: 'calibration_overdue', equipment_id: row.equipment_id, inventory_code: row.inventory_code, next_calibration_date: dateOnly(row.next_calibration_date) });
          eqOk.push(row);
        }
      } else eqOk.push(row);
    }
    const spOk: { row: NonNullable<ReturnType<typeof spRows.get>>; qty: number }[] = [];
    for (const r of spReq) {
      const row = r.id ? spRows.get(r.id) : undefined;
      const base = { type: 'supporting' as const, index: r.index, supporting_equipment_id: r.ref.supporting_equipment_id, qr_token: r.ref.qr_token, requested: r.ref.quantity };
      if (!row) problems.push({ ...base, reason: 'NOT_FOUND', message: 'Barang pendukung tidak ditemukan' });
      else {
        const named = { ...base, supporting_equipment_id: row.supporting_equipment_id, code: row.item_code, name: row.item_name, available: row.available_quantity };
        if (!row.is_active) problems.push({ ...named, reason: 'INACTIVE', message: 'Barang sudah dinonaktifkan' });
        else if (row.status === 'damaged' || row.condition === 'major_damage') problems.push({ ...named, reason: 'DAMAGED', message: 'Barang rusak' });
        else if (row.available_quantity < r.ref.quantity) {
          problems.push({ ...named, reason: 'INSUFFICIENT_STOCK', message: `Stok tidak cukup (tersedia ${row.available_quantity}, diminta ${r.ref.quantity})` });
        } else spOk.push({ row, qty: r.ref.quantity });
      }
    }
    if (problems.length) throw conflict('Sebagian item tidak dapat dipinjam; tidak ada yang disimpan', 'BORROWING_CONFLICT', problems);

    // 4) Perubahan atomik bersyarat (compare-and-set): gagal jika ada yang mengubah baris sejak dibaca.
    const raced: Problem[] = [];
    for (const row of eqOk) {
      const res = await tx.equipment.updateMany({
        where: { equipment_id: row.equipment_id, status: 'available', is_active: true },
        data: { status: 'borrowed' },
      });
      if (res.count !== 1) {
        raced.push({ type: 'equipment', index: eqReq.findIndex((x) => x.id === row.equipment_id), equipment_id: row.equipment_id, code: row.inventory_code, name: row.equipment_name, reason: 'NOT_AVAILABLE', message: 'Alat baru saja dipinjam pihak lain' });
      }
    }
    for (const { row, qty } of spOk) {
      const left = row.available_quantity - qty;
      assertQuantities(row.total_quantity, left);
      const res = await tx.supportingEquipment.updateMany({
        where: { supporting_equipment_id: row.supporting_equipment_id, available_quantity: row.available_quantity, is_active: true },
        data: { available_quantity: left, status: deriveSupportingStatus(row.condition, left) },
      });
      if (res.count !== 1) {
        raced.push({ type: 'supporting', index: spReq.findIndex((x) => x.id === row.supporting_equipment_id), supporting_equipment_id: row.supporting_equipment_id, code: row.item_code, name: row.item_name, reason: 'INSUFFICIENT_STOCK', requested: qty, message: 'Stok baru saja berubah, coba lagi' });
      }
    }
    if (raced.length) throw conflict('Sebagian item baru saja dipinjam pihak lain; tidak ada yang disimpan', 'BORROWING_CONFLICT', raced);

    // 5) Catat peminjaman.
    const b = await tx.borrowing.create({
      data: {
        user_id: actor.userId,
        borrowing_time: now,
        expected_return_time: body.expected_return_time,
        purpose: body.purpose,
        usage_location: body.usage_location ?? null,
        notes: body.notes ?? null,
        borrowing_status: 'borrowed',
      },
      select: { borrowing_id: true },
    });
    if (eqOk.length) {
      await tx.borrowingDetail.createMany({
        data: eqOk.map((r) => ({ borrowing_id: b.borrowing_id, equipment_id: r.equipment_id, initial_condition: r.condition })),
      });
    }
    if (spOk.length) {
      await tx.supportingBorrowingDetail.createMany({
        data: spOk.map(({ row, qty }) => ({
          borrowing_id: b.borrowing_id,
          supporting_equipment_id: row.supporting_equipment_id,
          quantity_borrowed: qty,
          initial_condition: row.condition,
        })),
      });
    }
    await audit.log(
      {
        userId: actor.userId,
        ip: actor.ip,
        action: AUDIT_ACTIONS.BORROW,
        entityType: AUDIT_ENTITIES.BORROWING,
        entityId: b.borrowing_id,
        newData: {
          purpose: body.purpose,
          expected_return_time: body.expected_return_time,
          equipment: eqOk.map((r) => ({ equipment_id: r.equipment_id, inventory_code: r.inventory_code })),
          supporting: spOk.map(({ row, qty }) => ({ supporting_equipment_id: row.supporting_equipment_id, item_code: row.item_code, quantity: qty })),
          warnings: warnings.map((w) => w.code),
        },
      },
      tx,
    );

    const detail = await loadDetail(tx, b.borrowing_id);
    return { ...detail!, can_return: true, warnings };
  });
}

// ───────── KEMBALI ─────────

/**
 * damageStatus:
 *  - 'any' (default, API utama): has_damage ATAU major_damage -> alat berstatus damaged.
 *  - 'major_only' (kontrak frontend): hanya has_damage + major_damage -> damaged; kerusakan ringan tetap available
 *    (kondisi diperbarui jadi minor_damage).
 */
export interface ReturnOptions {
  damageStatus?: 'any' | 'major_only';
}

export async function returnItems(id: string, body: ReturnBorrowingBody, actor: Actor, opts: ReturnOptions = {}) {
  const severe = (it: { has_damage: boolean; final_condition: ItemCondition }) =>
    opts.damageStatus === 'major_only' ? it.has_damage && it.final_condition === 'major_damage' : it.has_damage || it.final_condition === 'major_damage';
  return getDb().$transaction(async (tx) => {
    await lockBorrowing(tx, id);
    const b = await tx.borrowing.findUnique({ where: { borrowing_id: id } });
    if (!b) throw AppError.notFound('Peminjaman tidak ditemukan');
    if (b.user_id !== actor.userId && !PERMISSIONS.borrowings.returnAny.includes(actor.role)) {
      throw AppError.forbidden('Hanya peminjam, admin, atau SPV yang dapat memproses pengembalian');
    }
    if (b.borrowing_status === 'returned') throw new AppError(409, 'BORROWING_ALREADY_RETURNED', 'Peminjaman sudah selesai dikembalikan');

    const eqDetails = await tx.borrowingDetail.findMany({ where: { borrowing_id: id } });
    const spDetails = await tx.supportingBorrowingDetail.findMany({ where: { borrowing_id: id } });
    const eqById = new Map(eqDetails.map((d) => [d.detail_id, d]));
    const spById = new Map(spDetails.map((d) => [d.supporting_detail_id, d]));

    const problems: (Omit<Problem, 'type' | 'index'> & { type: 'equipment' | 'supporting'; detail_id?: string })[] = [];
    const seen = new Set<string>();
    const eqTodo = body.items.flatMap((it) => {
      const d = eqById.get(it.detail_id);
      if (!d) return problems.push({ type: 'equipment', detail_id: it.detail_id, reason: 'NOT_IN_BORROWING', message: 'detail_id bukan bagian dari peminjaman ini' }), [];
      if (d.final_condition !== null) return problems.push({ type: 'equipment', detail_id: it.detail_id, reason: 'ALREADY_RETURNED', message: 'Alat sudah dikembalikan' }), [];
      if (seen.has(it.detail_id)) return problems.push({ type: 'equipment', detail_id: it.detail_id, reason: 'DUPLICATE', message: 'detail_id duplikat' }), [];
      seen.add(it.detail_id);
      return [{ it, d }];
    });
    const spTodo = body.supporting.flatMap((it) => {
      const d = spById.get(it.supporting_detail_id);
      const base = { type: 'supporting' as const, detail_id: it.supporting_detail_id };
      if (!d) return problems.push({ ...base, reason: 'NOT_IN_BORROWING', message: 'supporting_detail_id bukan bagian dari peminjaman ini' }), [];
      if (seen.has(it.supporting_detail_id)) return problems.push({ ...base, reason: 'DUPLICATE', message: 'supporting_detail_id duplikat' }), [];
      seen.add(it.supporting_detail_id);
      const outstanding = d.quantity_borrowed - d.quantity_returned;
      if (it.quantity_returned > outstanding) {
        return problems.push({ ...base, reason: 'QUANTITY_EXCEEDS_OUTSTANDING', requested: it.quantity_returned, available: Math.max(outstanding, 0), message: `Jumlah melebihi yang belum dikembalikan (${Math.max(outstanding, 0)})` }), [];
      }
      return [{ it, d }];
    });
    if (problems.length) throw new AppError(409, 'RETURN_CONFLICT', 'Pengembalian ditolak; tidak ada yang disimpan', { items: problems });

    // kunci item terkait (urut id) lalu baca ulang
    const eqIds = eqTodo.map((x) => x.d.equipment_id);
    const spIds = spTodo.map((x) => x.d.supporting_equipment_id);
    await lockEquipment(tx, uniq(eqIds));
    await lockSupporting(tx, uniq(spIds));
    const eqRows = new Map((eqIds.length ? await tx.equipment.findMany({ where: { equipment_id: { in: eqIds } }, select: EQ_SELECT }) : []).map((r) => [r.equipment_id, r]));
    const spRows = new Map((spIds.length ? await tx.supportingEquipment.findMany({ where: { supporting_equipment_id: { in: spIds } }, select: SP_SELECT }) : []).map((r) => [r.supporting_equipment_id, r]));

    const damaged: string[] = [];
    const returnedEq: { inventory_code: string; status: string; condition: string }[] = [];
    for (const { it, d } of eqTodo) {
      const row = eqRows.get(d.equipment_id);
      if (!row) throw AppError.internal('Data alat tidak ditemukan untuk detail peminjaman');
      const isDamaged = severe(it);
      const nextStatus = isDamaged ? 'damaged' : 'available';
      const res = await tx.equipment.updateMany({
        where: { equipment_id: row.equipment_id, status: 'borrowed' },
        data: { status: nextStatus, condition: it.final_condition },
      });
      if (res.count !== 1) {
        throw new AppError(409, 'RETURN_CONFLICT', 'Status alat tidak lagi "borrowed"; hubungi admin', {
          items: [{ type: 'equipment', detail_id: it.detail_id, code: row.inventory_code, reason: 'STATUS_CHANGED', message: `Status alat saat ini: ${row.status}` }],
        });
      }
      await tx.borrowingDetail.update({
        where: { detail_id: d.detail_id },
        data: { final_condition: it.final_condition, has_damage: opts.damageStatus === 'major_only' ? it.has_damage : isDamaged, damage_notes: it.damage_notes ?? null },
      });
      d.final_condition = it.final_condition; // untuk penentuan selesai
      if (isDamaged) damaged.push(`${row.inventory_code} (${row.equipment_name})`);
      returnedEq.push({ inventory_code: row.inventory_code, status: nextStatus, condition: it.final_condition });
    }

    const returnedSp: { item_code: string; quantity_returned: number }[] = [];
    for (const { it, d } of spTodo) {
      const row = spRows.get(d.supporting_equipment_id);
      if (!row) throw AppError.internal('Data barang tidak ditemukan untuk detail peminjaman');
      const avail = row.available_quantity + it.quantity_returned;
      assertQuantities(row.total_quantity, avail);
      const res = await tx.supportingEquipment.updateMany({
        where: { supporting_equipment_id: row.supporting_equipment_id, available_quantity: row.available_quantity },
        data: { available_quantity: avail, status: deriveSupportingStatus(row.condition, avail) },
      });
      if (res.count !== 1) throw new AppError(409, 'RETURN_CONFLICT', 'Stok berubah saat diproses, coba lagi');
      const worst = d.final_condition && RANK[d.final_condition as ItemCondition] > RANK[it.final_condition] ? d.final_condition : it.final_condition;
      const isDamaged = severe(it);
      const notes = [d.damage_notes, it.damage_notes].filter(Boolean).join(' | ') || null;
      const returned = d.quantity_returned + it.quantity_returned;
      await tx.supportingBorrowingDetail.update({
        where: { supporting_detail_id: d.supporting_detail_id },
        data: { quantity_returned: returned, final_condition: worst, has_damage: d.has_damage || (opts.damageStatus === 'major_only' ? it.has_damage : isDamaged), damage_notes: notes },
      });
      d.quantity_returned = returned;
      if (isDamaged) damaged.push(`${row.item_code} (${row.item_name}) x${it.quantity_returned}`);
      returnedSp.push({ item_code: row.item_code, quantity_returned: it.quantity_returned });
    }

    const completed =
      eqDetails.every((d) => d.final_condition !== null) && spDetails.every((d) => d.quantity_returned >= d.quantity_borrowed);
    if (completed) {
      await tx.borrowing.update({ where: { borrowing_id: id }, data: { borrowing_status: 'returned', actual_return_time: new Date() } });
    }

    let notified = 0;
    if (damaged.length) {
      notified = await notifyRoles(tx, DAMAGE_RECIPIENT_ROLES, {
        type: 'maintenance',
        title: 'Kerusakan saat pengembalian',
        message: `Peminjaman ${id.slice(0, 8)}: ${damaged.join(', ')}`,
        borrowing_id: id,
      });
    }
    await audit.log(
      {
        userId: actor.userId,
        ip: actor.ip,
        action: AUDIT_ACTIONS.RETURN,
        entityType: AUDIT_ENTITIES.BORROWING,
        entityId: id,
        newData: { equipment: returnedEq, supporting: returnedSp, completed, damaged, notified },
      },
      tx,
    );

    const detail = await loadDetail(tx, id);
    return { ...detail!, can_return: !completed, completed, damage_reported: damaged.length > 0 };
  });
}

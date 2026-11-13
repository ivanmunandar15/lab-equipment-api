import type { Prisma } from '@prisma/client';
import { getDb } from '../../config/db';
import { AppError } from '../../utils/errors';
import { buildMeta, getPagination, resolveSort } from '../../utils/pagination';
import { uniqueViolation } from '../../utils/prisma-errors';
import { qrPng, supportingQrUrl } from '../../utils/qr';
import { generateQrToken } from '../../utils/qr-token';
import { assertQuantities, deriveSupportingStatus } from './supporting-equipment.derive';
import type {
  CreateSupportingBody,
  ExportSupportingQuery,
  ListSupportingQuery,
  UpdateSupportingBody,
} from './supporting-equipment.schema';

const SORTABLE = [
  'item_name', 'item_code', 'item_type', 'status', 'condition', 'total_quantity', 'available_quantity', 'created_at', 'updated_at',
];

export const SUPPORTING_SELECT = {
  supporting_equipment_id: true,
  item_code: true,
  qr_token: true,
  item_name: true,
  item_type: true,
  brand: true,
  model: true,
  unit: true,
  total_quantity: true,
  available_quantity: true,
  condition: true,
  status: true,
  description: true,
  specifications: true,
  is_active: true,
  created_at: true,
  updated_at: true,
} satisfies Prisma.SupportingEquipmentSelect;

export type SupportingRow = Prisma.SupportingEquipmentGetPayload<{ select: typeof SUPPORTING_SELECT }>;

export const presentSupporting = (row: SupportingRow) => ({
  ...row,
  borrowed_quantity: row.total_quantity - row.available_quantity,
  qr_url: supportingQrUrl(row.qr_token),
});

type Filters = Partial<Pick<ListSupportingQuery, 'status' | 'condition' | 'item_type' | 'is_active' | 'search'>> &
  Pick<Partial<ExportSupportingQuery>, 'ids'>;

/** Dipakai bersama oleh list dan ekspor. */
export function buildWhere(f: Filters): Prisma.SupportingEquipmentWhereInput {
  return {
    ...(f.status ? { status: f.status } : {}),
    ...(f.condition ? { condition: f.condition } : {}),
    ...(f.item_type ? { item_type: { equals: f.item_type, mode: 'insensitive' } } : {}),
    ...(f.is_active !== undefined ? { is_active: f.is_active } : {}),
    ...(f.ids ? { supporting_equipment_id: { in: f.ids } } : {}),
    ...(f.search
      ? {
          OR: [
            { item_name: { contains: f.search, mode: 'insensitive' } },
            { item_code: { contains: f.search, mode: 'insensitive' } },
          ],
        }
      : {}),
  };
}

const notFound = () => AppError.notFound('Supporting equipment tidak ditemukan');
const dupCode = () => AppError.conflict('item_code sudah dipakai', { field: 'item_code' });

export async function list(q: ListSupportingQuery) {
  const db = getDb();
  const where = buildWhere(q);
  const { page, limit, skip, take } = getPagination(q);
  const sortField = resolveSort(q.sort, SORTABLE, 'created_at');
  const [rows, total] = await Promise.all([
    db.supportingEquipment.findMany({
      where,
      orderBy: [{ [sortField]: q.order }, { supporting_equipment_id: 'asc' }],
      skip,
      take,
      select: SUPPORTING_SELECT,
    }),
    db.supportingEquipment.count({ where }),
  ]);
  return { items: rows.map(presentSupporting), meta: buildMeta(page, limit, total) };
}

/** Bentuk sama dengan respons create/update (dipakai sebagai old_data audit). */
export async function getBasic(id: string) {
  const row = await getDb().supportingEquipment.findUnique({ where: { supporting_equipment_id: id }, select: SUPPORTING_SELECT });
  if (!row) throw notFound();
  return presentSupporting(row);
}

const ACTIVE_LOAN = (id: string): Prisma.SupportingBorrowingDetailWhereInput => ({
  supporting_equipment_id: id,
  borrowing: { borrowing_status: 'borrowed' },
});

/** Jumlah yang masih di luar (dipinjam − dikembalikan) dari peminjaman aktif; sumber kebenaran untuk validasi. */
async function outstandingQuantity(tx: Pick<Prisma.TransactionClient, 'supportingBorrowingDetail'>, id: string) {
  const rows = await tx.supportingBorrowingDetail.findMany({
    where: ACTIVE_LOAN(id),
    select: { quantity_borrowed: true, quantity_returned: true },
  });
  return rows.reduce((sum, r) => sum + Math.max(r.quantity_borrowed - r.quantity_returned, 0), 0);
}

export async function getById(id: string) {
  const db = getDb();
  const row = await db.supportingEquipment.findUnique({ where: { supporting_equipment_id: id }, select: SUPPORTING_SELECT });
  if (!row) throw notFound();

  const loans = await db.supportingBorrowingDetail.findMany({
    where: ACTIVE_LOAN(id),
    orderBy: { borrowing: { borrowing_time: 'asc' } },
    select: {
      supporting_detail_id: true,
      quantity_borrowed: true,
      quantity_returned: true,
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
  const now = Date.now();
  const active_borrowings = loans
    .map((l) => ({
      borrowing_id: l.borrowing.borrowing_id,
      supporting_detail_id: l.supporting_detail_id,
      user: l.borrowing.user,
      quantity_borrowed: l.quantity_borrowed,
      quantity_returned: l.quantity_returned,
      quantity_outstanding: Math.max(l.quantity_borrowed - l.quantity_returned, 0),
      initial_condition: l.initial_condition,
      borrowing_time: l.borrowing.borrowing_time,
      expected_return_time: l.borrowing.expected_return_time,
      purpose: l.borrowing.purpose,
      usage_location: l.borrowing.usage_location,
      // overdue tidak disimpan: dihitung dari expected_return_time dan status
      is_overdue: l.borrowing.expected_return_time.getTime() < now,
    }))
    .filter((l) => l.quantity_outstanding > 0);

  return { ...presentSupporting(row), active_borrowings };
}

export async function create(body: CreateSupportingBody) {
  const db = getDb();
  if (await db.supportingEquipment.findUnique({ where: { item_code: body.item_code }, select: { supporting_equipment_id: true } })) {
    throw dupCode();
  }
  const available = body.total_quantity; // saat dibuat belum ada yang dipinjam
  assertQuantities(body.total_quantity, available);
  // qr_token dibuat server SEKALI di sini; ulangi jika bentrok.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const row = await db.supportingEquipment.create({
        data: {
          ...body,
          available_quantity: available,
          status: deriveSupportingStatus(body.condition, available),
          qr_token: generateQrToken(),
        },
        select: SUPPORTING_SELECT,
      });
      return presentSupporting(row);
    } catch (err) {
      const v = uniqueViolation(err);
      if (v === null) throw err;
      if (v.includes('qr_token')) continue;
      if (v.includes('item_code')) throw dupCode();
      throw err;
    }
  }
  throw AppError.internal('Gagal membuat qr_token unik, coba lagi');
}

const borrowedError = (outstanding: number) =>
  new AppError(409, 'ITEM_BORROWED', 'Item masih dipinjam; kembalikan dulu sebelum menonaktifkan', { borrowed_quantity: outstanding });

/** Kunci baris item (SELECT ... FOR UPDATE) agar penyesuaian stok aman dari race condition. */
const lockItem = (tx: Prisma.TransactionClient, id: string) =>
  tx.$queryRaw`SELECT supporting_equipment_id FROM supporting_equipment WHERE supporting_equipment_id = ${id}::uuid FOR UPDATE`;

export async function update(id: string, body: UpdateSupportingBody) {
  try {
    return await getDb().$transaction(async (tx) => {
      await lockItem(tx, id);
      const cur = await tx.supportingEquipment.findUnique({
        where: { supporting_equipment_id: id },
        select: { total_quantity: true, available_quantity: true, condition: true, is_active: true, item_code: true },
      });
      if (!cur) throw notFound();

      if (body.item_code !== undefined && body.item_code !== cur.item_code) {
        if (await tx.supportingEquipment.findUnique({ where: { item_code: body.item_code }, select: { supporting_equipment_id: true } })) {
          throw dupCode();
        }
      }

      const outstanding = await outstandingQuantity(tx, id);
      if (body.is_active === false && cur.is_active && outstanding > 0) throw borrowedError(outstanding);

      let total = cur.total_quantity;
      let available = cur.available_quantity;
      if (body.total_quantity !== undefined && body.total_quantity !== cur.total_quantity) {
        if (body.total_quantity < outstanding) {
          throw new AppError(409, 'QUANTITY_BELOW_BORROWED', 'total_quantity tidak boleh lebih kecil dari jumlah yang sedang dipinjam', {
            total_quantity: body.total_quantity,
            borrowed_quantity: outstanding,
          });
        }
        available = cur.available_quantity + (body.total_quantity - cur.total_quantity);
        total = body.total_quantity;
      }
      assertQuantities(total, available);

      // `body` hanya berisi field whitelist Zod → qr_token, available_quantity, status tidak ikut dari client.
      const row = await tx.supportingEquipment.update({
        where: { supporting_equipment_id: id },
        data: {
          ...body,
          total_quantity: total,
          available_quantity: available,
          status: deriveSupportingStatus(body.condition ?? cur.condition, available),
        },
        select: SUPPORTING_SELECT,
      });
      return presentSupporting(row);
    });
  } catch (err) {
    if (uniqueViolation(err)?.includes('item_code')) throw dupCode();
    throw err;
  }
}

/** Soft delete; ditolak jika masih ada yang dipinjam. */
export async function remove(id: string) {
  return getDb().$transaction(async (tx) => {
    await lockItem(tx, id);
    const cur = await tx.supportingEquipment.findUnique({
      where: { supporting_equipment_id: id },
      select: { supporting_equipment_id: true },
    });
    if (!cur) throw notFound();
    const outstanding = await outstandingQuantity(tx, id);
    if (outstanding > 0) throw borrowedError(outstanding);
    const row = await tx.supportingEquipment.update({
      where: { supporting_equipment_id: id },
      data: { is_active: false },
      select: SUPPORTING_SELECT,
    });
    return presentSupporting(row);
  });
}

export async function getQrPng(id: string, size: number) {
  const row = await getDb().supportingEquipment.findUnique({
    where: { supporting_equipment_id: id },
    select: { item_code: true, qr_token: true },
  });
  if (!row) throw notFound();
  return { item_code: row.item_code, png: await qrPng(supportingQrUrl(row.qr_token), size) };
}

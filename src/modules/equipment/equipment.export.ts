import type { Prisma } from '@prisma/client';
import type { Response } from 'express';
import { getDb } from '../../config/db';
import { AppError } from '../../utils/errors';
import { csvSafe } from '../../utils/csv';
import {
  stamp,
  streamCsvDownload,
  streamLabelsPdf as renderLabels,
  streamQrZip,
  type LabelLayout,
} from '../../utils/export-stream';
import { equipmentQrUrl } from '../../utils/qr';
import { EQUIPMENT_SELECT, presentEquipment, type EquipmentRow } from './equipment.service';

export const CSV_COLUMNS = [
  'equipment_id', 'inventory_code', 'equipment_name', 'equipment_type', 'brand', 'model',
  'room_id', 'room_code', 'room_name', 'status', 'condition', 'purchase_date', 'purchase_price',
  'useful_life_years', 'specifications', 'next_calibration_date', 'is_active', 'qr_token', 'qr_url',
  'created_at', 'updated_at',
];

const BATCH = 500;
const LABEL = 'ekspor equipment';

/** Iterasi bertahap (cursor, urut inventory_code) agar tidak memuat semua baris ke memori. */
async function* iterate(where: Prisma.EquipmentWhereInput): AsyncGenerator<EquipmentRow> {
  const db = getDb();
  let cursor: string | undefined;
  for (;;) {
    const rows = await db.equipment.findMany({
      where,
      orderBy: { inventory_code: 'asc' },
      take: BATCH,
      ...(cursor ? { cursor: { inventory_code: cursor }, skip: 1 } : {}),
      select: EQUIPMENT_SELECT,
    });
    yield* rows;
    if (rows.length < BATCH) return;
    cursor = rows[rows.length - 1].inventory_code;
  }
}

async function* csvRecords(where: Prisma.EquipmentWhereInput) {
  for await (const r of iterate(where)) {
    const p = presentEquipment(r);
    const rec: Record<string, unknown> = {
      equipment_id: p.equipment_id, inventory_code: p.inventory_code, equipment_name: p.equipment_name,
      equipment_type: p.equipment_type, brand: p.brand, model: p.model, room_id: p.room_id,
      room_code: p.room.room_code, room_name: p.room.room_name, status: p.status, condition: p.condition,
      purchase_date: p.purchase_date, purchase_price: p.purchase_price, useful_life_years: p.useful_life_years,
      specifications: p.specifications, next_calibration_date: p.next_calibration_date, is_active: p.is_active,
      qr_token: p.qr_token, qr_url: p.qr_url, created_at: p.created_at.toISOString(), updated_at: p.updated_at.toISOString(),
    };
    yield Object.fromEntries(CSV_COLUMNS.map((c) => [c, csvSafe(rec[c])]));
  }
}

async function* zipEntries(where: Prisma.EquipmentWhereInput) {
  for await (const r of iterate(where)) yield { code: r.inventory_code, qr_url: equipmentQrUrl(r.qr_token) };
}

/** Cek awal (di luar stream) agar error DB masih bisa dibalas sebagai JSON. */
const precheck = (where: Prisma.EquipmentWhereInput) => getDb().equipment.count({ where });

export async function streamCsv(where: Prisma.EquipmentWhereInput, res: Response) {
  await precheck(where);
  await streamCsvDownload(res, LABEL, `equipment-${stamp()}.csv`, CSV_COLUMNS, csvRecords(where));
}

export async function streamZip(where: Prisma.EquipmentWhereInput, res: Response) {
  await precheck(where);
  await streamQrZip(res, {
    label: LABEL,
    filename: `equipment-${stamp()}.zip`,
    csvName: 'equipment.csv',
    columns: CSV_COLUMNS,
    rows: csvRecords(where),
    entries: zipEntries(where),
  });
}

export async function streamLabelsPdf(ids: string[], layout: LabelLayout, res: Response) {
  const rows = await getDb().equipment.findMany({
    where: { equipment_id: { in: ids } },
    select: { equipment_id: true, inventory_code: true, equipment_name: true, qr_token: true },
  });
  const byId = new Map(rows.map((r) => [r.equipment_id, r]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length) throw AppError.notFound('Sebagian equipment tidak ditemukan', { missing_ids: missing });
  const items = ids.map((id) => {
    const r = byId.get(id)!;
    return { title: r.equipment_name, code: r.inventory_code, qr_url: equipmentQrUrl(r.qr_token) };
  });
  await renderLabels(res, { label: LABEL, filename: 'equipment-labels.pdf', docTitle: 'Label Equipment', layout, items });
}

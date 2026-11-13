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
import { supportingQrUrl } from '../../utils/qr';
import { SUPPORTING_SELECT, presentSupporting, type SupportingRow } from './supporting-equipment.service';

export const CSV_COLUMNS = [
  'supporting_equipment_id', 'item_code', 'item_name', 'item_type', 'brand', 'model', 'unit',
  'total_quantity', 'available_quantity', 'borrowed_quantity', 'condition', 'status', 'description',
  'specifications', 'is_active', 'qr_token', 'qr_url', 'created_at', 'updated_at',
];

const BATCH = 500;
const LABEL = 'ekspor supporting equipment';

async function* iterate(where: Prisma.SupportingEquipmentWhereInput): AsyncGenerator<SupportingRow> {
  const db = getDb();
  let cursor: string | undefined;
  for (;;) {
    const rows = await db.supportingEquipment.findMany({
      where,
      orderBy: { item_code: 'asc' },
      take: BATCH,
      ...(cursor ? { cursor: { item_code: cursor }, skip: 1 } : {}),
      select: SUPPORTING_SELECT,
    });
    yield* rows;
    if (rows.length < BATCH) return;
    cursor = rows[rows.length - 1].item_code;
  }
}

async function* csvRecords(where: Prisma.SupportingEquipmentWhereInput) {
  for await (const r of iterate(where)) {
    const p = presentSupporting(r);
    const rec: Record<string, unknown> = {
      ...p,
      created_at: p.created_at.toISOString(),
      updated_at: p.updated_at.toISOString(),
    };
    yield Object.fromEntries(CSV_COLUMNS.map((c) => [c, csvSafe(rec[c])]));
  }
}

async function* zipEntries(where: Prisma.SupportingEquipmentWhereInput) {
  for await (const r of iterate(where)) yield { code: r.item_code, qr_url: supportingQrUrl(r.qr_token) };
}

const precheck = (where: Prisma.SupportingEquipmentWhereInput) => getDb().supportingEquipment.count({ where });

export async function streamCsv(where: Prisma.SupportingEquipmentWhereInput, res: Response) {
  await precheck(where);
  await streamCsvDownload(res, LABEL, `supporting-equipment-${stamp()}.csv`, CSV_COLUMNS, csvRecords(where));
}

export async function streamZip(where: Prisma.SupportingEquipmentWhereInput, res: Response) {
  await precheck(where);
  await streamQrZip(res, {
    label: LABEL,
    filename: `supporting-equipment-${stamp()}.zip`,
    csvName: 'supporting-equipment.csv',
    columns: CSV_COLUMNS,
    rows: csvRecords(where),
    entries: zipEntries(where),
  });
}

export async function streamLabelsPdf(ids: string[], layout: LabelLayout, res: Response) {
  const rows = await getDb().supportingEquipment.findMany({
    where: { supporting_equipment_id: { in: ids } },
    select: { supporting_equipment_id: true, item_code: true, item_name: true, qr_token: true },
  });
  const byId = new Map(rows.map((r) => [r.supporting_equipment_id, r]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length) throw AppError.notFound('Sebagian supporting equipment tidak ditemukan', { missing_ids: missing });
  const items = ids.map((id) => {
    const r = byId.get(id)!;
    return { title: r.item_name, code: r.item_code, qr_url: supportingQrUrl(r.qr_token) };
  });
  await renderLabels(res, { label: LABEL, filename: 'supporting-equipment-labels.pdf', docTitle: 'Label Supporting Equipment', layout, items });
}

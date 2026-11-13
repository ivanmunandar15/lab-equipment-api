import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getDb } from '../../config/db';
import { AppError } from '../../utils/errors';
import { csvText, parseCsv, type ParsedCsv } from '../../utils/csv';
import { uniqueViolation } from '../../utils/prisma-errors';
import { supportingQrUrl } from '../../utils/qr';
import { generateQrToken } from '../../utils/qr-token';
import { AUDIT_ACTIONS, AUDIT_ENTITIES, audit } from '../activity-logs/audit.service';
import { CONDITIONS } from '../equipment/equipment.schema';
import { deriveSupportingStatus } from './supporting-equipment.derive';
import { supportingFields } from './supporting-equipment.schema';

export const MAX_IMPORT_ROWS = 1000;
const MAX_REPORTED_ERRORS = 500;

export const IMPORT_COLUMNS = [
  'item_code', 'item_name', 'item_type', 'brand', 'model', 'unit', 'total_quantity', 'condition', 'description', 'specifications',
];
const REQUIRED = ['item_code', 'item_name', 'total_quantity'];

export const importTemplateCsv = () =>
  csvText(IMPORT_COLUMNS, [
    {
      item_code: 'SUP-001', item_name: 'Gelas Beaker 250 ml', item_type: 'Glassware', brand: 'Iwaki', model: 'Beaker 250',
      unit: 'pcs', total_quantity: '40', condition: 'good', description: 'Beaker borosilikat', specifications: 'Skala 25 ml',
    },
    { item_code: 'SUP-002', item_name: 'Spatula Stainless', total_quantity: '25' },
  ]);

const empty = <T extends z.ZodTypeAny>(s: T) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), s.optional());

const rowSchema = z.object({
  item_code: supportingFields.item_code,
  item_name: supportingFields.item_name,
  total_quantity: z.coerce
    .number({ invalid_type_error: 'harus berupa angka' })
    .int('harus bilangan bulat')
    .min(1, 'minimal 1')
    .max(1_000_000),
  item_type: empty(z.string().trim().max(100)),
  brand: empty(z.string().trim().max(100)),
  model: empty(z.string().trim().max(100)),
  unit: empty(supportingFields.unit),
  condition: empty(z.enum(CONDITIONS, { errorMap: () => ({ message: `harus salah satu dari: ${CONDITIONS.join(', ')}` }) })),
  description: empty(z.string().trim().max(2000)),
  specifications: empty(z.string().trim().max(5000)),
});

export interface ImportError {
  row: number;
  field: string;
  message: string;
}
interface ValidRow {
  row: number;
  data: z.infer<typeof rowSchema>;
}
interface Validation {
  total: number;
  errors: ImportError[];
  valid: ValidRow[];
}

const issueMessage = (i: z.ZodIssue) => (i.code === 'invalid_type' && i.received === 'undefined' ? 'wajib diisi' : i.message);

async function validateRows(db: Pick<ReturnType<typeof getDb>, 'supportingEquipment'>, parsed: ParsedCsv): Promise<Validation> {
  const errors: ImportError[] = [];
  const candidates: ValidRow[] = [];
  parsed.rows.forEach((raw, idx) => {
    const row = idx + 2; // baris 1 = header
    const r = rowSchema.safeParse(Object.fromEntries(IMPORT_COLUMNS.map((c) => [c, raw[c]])));
    if (r.success) candidates.push({ row, data: r.data });
    else r.error.issues.forEach((i) => errors.push({ row, field: String(i.path[0] ?? ''), message: issueMessage(i) }));
  });

  const firstSeen = new Map<string, number>();
  let pool = candidates.filter((c) => {
    const first = firstSeen.get(c.data.item_code);
    if (first === undefined) {
      firstSeen.set(c.data.item_code, c.row);
      return true;
    }
    errors.push({ row: c.row, field: 'item_code', message: `Duplikat dengan baris ${first}` });
    return false;
  });

  if (pool.length) {
    const existing = await db.supportingEquipment.findMany({
      where: { item_code: { in: pool.map((c) => c.data.item_code) } },
      select: { item_code: true },
    });
    const taken = new Set(existing.map((e) => e.item_code));
    pool = pool.filter((c) => {
      if (!taken.has(c.data.item_code)) return true;
      errors.push({ row: c.row, field: 'item_code', message: 'item_code sudah terdaftar' });
      return false;
    });
  }

  errors.sort((a, b) => a.row - b.row);
  return { total: parsed.rows.length, errors, valid: pool };
}

function summarize(v: Validation, dryRun: boolean, allOrNothing: boolean) {
  return {
    dry_run: dryRun,
    all_or_nothing: allOrNothing,
    total_rows: v.total,
    valid_rows: v.valid.length,
    invalid_rows: new Set(v.errors.map((e) => e.row)).size,
    error_count: v.errors.length,
    errors: v.errors.slice(0, MAX_REPORTED_ERRORS),
    errors_truncated: v.errors.length > MAX_REPORTED_ERRORS,
  };
}

function parseAndCheck(buf: Buffer) {
  const parsed = parseCsv(buf, MAX_IMPORT_ROWS);
  const missing = REQUIRED.filter((c) => !parsed.headers.includes(c));
  if (missing.length) {
    throw new AppError(422, 'INVALID_CSV_HEADER', `Kolom wajib tidak ada: ${missing.join(', ')}`, { missing, found: parsed.headers });
  }
  if (parsed.rows.length === 0) throw new AppError(422, 'CSV_EMPTY', 'CSV tidak berisi baris data');
  return parsed;
}

export interface ImportOptions {
  dry_run: boolean;
  all_or_nothing: boolean;
}
export interface ImportActor {
  userId: string | null;
  ip: string | null;
}

export async function importCsv(file: { buffer: Buffer; originalname: string }, opts: ImportOptions, actor: ImportActor) {
  const parsed = parseAndCheck(file.buffer);
  const db = getDb();

  if (opts.dry_run) {
    const v = await validateRows(db, parsed);
    return { status: 200, body: { ...summarize(v, true, opts.all_or_nothing), would_create: v.valid.length } };
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await db.$transaction(
        async (tx) => {
          // validasi ulang di dalam transaksi (data bisa berubah sejak dry run)
          const v = await validateRows(tx, parsed);

          if (opts.all_or_nothing && v.errors.length > 0) {
            throw new AppError(422, 'IMPORT_VALIDATION_FAILED', 'Impor dibatalkan: ada baris yang tidak valid, tidak ada data yang disimpan', {
              total_rows: v.total,
              invalid_rows: new Set(v.errors.map((e) => e.row)).size,
              errors: v.errors.slice(0, MAX_REPORTED_ERRORS),
              errors_truncated: v.errors.length > MAX_REPORTED_ERRORS,
            });
          }

          const tokens = new Set<string>();
          const items = v.valid.map((r) => {
            let token = generateQrToken();
            while (tokens.has(token)) token = generateQrToken();
            tokens.add(token);
            const condition = r.data.condition ?? 'good';
            const data = Object.fromEntries(Object.entries(r.data).filter(([, v]) => v !== undefined)) as typeof r.data;
            return {
              row: r.row,
              supporting_equipment_id: randomUUID(),
              qr_token: token,
              ...data,
              condition,
              available_quantity: r.data.total_quantity,
              status: deriveSupportingStatus(condition, r.data.total_quantity),
            };
          });

          if (items.length) {
            await tx.supportingEquipment.createMany({
              data: items.map(({ row, ...rest }) => {
                void row;
                return rest;
              }),
            });
            await audit.log(
              {
                ...actor,
                action: AUDIT_ACTIONS.IMPORT,
                entityType: AUDIT_ENTITIES.SUPPORTING_EQUIPMENT,
                newData: {
                  file_name: file.originalname,
                  created_count: items.length,
                  skipped_count: v.total - items.length,
                  item_codes: items.slice(0, 500).map((i) => i.item_code),
                },
              },
              tx,
            );
          }

          return {
            status: items.length ? 201 : 200,
            body: {
              ...summarize(v, false, opts.all_or_nothing),
              created_count: items.length,
              skipped_count: v.total - items.length,
              created: items.map((i) => ({
                row: i.row,
                supporting_equipment_id: i.supporting_equipment_id,
                item_code: i.item_code,
                qr_token: i.qr_token,
                qr_url: supportingQrUrl(i.qr_token),
              })),
            },
          };
        },
        { timeout: 30_000 },
      );
    } catch (err) {
      const u = uniqueViolation(err);
      if (u === null) throw err;
      if (u.includes('qr_token')) continue;
      throw AppError.conflict('Impor bentrok dengan data lain yang baru disimpan, ulangi proses impor');
    }
  }
  throw AppError.internal('Gagal membuat qr_token unik, coba lagi');
}

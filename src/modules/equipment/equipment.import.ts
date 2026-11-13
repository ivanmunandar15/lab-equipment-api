import type { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getDb } from '../../config/db';
import { env } from '../../config/env';
import { AppError } from '../../utils/errors';
import { csvText, parseCsv, type ParsedCsv } from '../../utils/csv';
import { uniqueViolation } from '../../utils/prisma-errors';
import { equipmentQrUrl } from '../../utils/qr';
import { generateQrToken } from '../../utils/qr-token';
import { AUDIT_ACTIONS, AUDIT_ENTITIES, audit } from '../activity-logs/audit.service';
import { buildCapacityWarning, lockRooms, type CapacityWarning } from '../rooms/room-capacity';
import { CONDITIONS, SETTABLE_STATUSES, dateOnlySchema, equipmentFields, priceSchema } from './equipment.schema';

export const MAX_IMPORT_ROWS = 1000;
const MAX_REPORTED_ERRORS = 500;

export const IMPORT_COLUMNS = [
  'inventory_code', 'equipment_name', 'equipment_type', 'brand', 'model', 'room_code', 'status', 'condition',
  'purchase_date', 'purchase_price', 'useful_life_years', 'specifications', 'next_calibration_date',
];
const REQUIRED = ['inventory_code', 'equipment_name', 'equipment_type', 'room_code'];

export const importTemplateCsv = () =>
  csvText(IMPORT_COLUMNS, [
    {
      inventory_code: 'LAB/EQ/0001', equipment_name: 'Oven Laboratorium', equipment_type: 'Oven', brand: 'Memmert', model: 'UN55',
      room_code: 'LAB-A', status: 'available', condition: 'good', purchase_date: '2024-03-15', purchase_price: '45000000',
      useful_life_years: '10', specifications: 'Rentang suhu hingga 300C', next_calibration_date: '2026-12-01',
    },
    { inventory_code: 'LAB/EQ/0002', equipment_name: 'Timbangan Analitik', equipment_type: 'Timbangan Analitik', room_code: 'LAB-A' },
  ]);

// '' → undefined agar kolom kosong dianggap tidak diisi
const empty = <T extends z.ZodTypeAny>(s: T) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), s.optional());

const rowSchema = z.object({
  inventory_code: equipmentFields.inventory_code,
  equipment_name: equipmentFields.equipment_name,
  equipment_type: equipmentFields.equipment_type,
  room_code: z.string().trim().min(1, 'wajib diisi').max(30),
  brand: empty(z.string().trim().max(100)),
  model: empty(z.string().trim().max(100)),
  status: empty(z.enum(SETTABLE_STATUSES, { errorMap: () => ({ message: `harus salah satu dari: ${SETTABLE_STATUSES.join(', ')}` }) })),
  condition: empty(z.enum(CONDITIONS, { errorMap: () => ({ message: `harus salah satu dari: ${CONDITIONS.join(', ')}` }) })),
  purchase_date: empty(dateOnlySchema),
  purchase_price: empty(priceSchema),
  useful_life_years: empty(z.coerce.number({ invalid_type_error: 'harus berupa angka' }).int('harus bilangan bulat').min(1).max(100)),
  specifications: empty(z.string().trim().max(5000)),
  next_calibration_date: empty(dateOnlySchema),
});

export interface ImportError {
  row: number;
  field: string;
  message: string;
}

interface ValidRow {
  row: number;
  room: { room_id: string; room_code: string; equipment_capacity: number };
  data: Omit<z.infer<typeof rowSchema>, 'room_code'>;
}

interface Validation {
  total: number;
  errors: ImportError[];
  valid: ValidRow[];
  warnings: CapacityWarning[];
}

type Client = Pick<Prisma.TransactionClient, 'equipment' | 'room'>;

const issueMessage = (i: z.ZodIssue) =>
  i.code === 'invalid_type' && i.received === 'undefined' ? 'wajib diisi' : i.message;

async function validateRows(db: Client, parsed: ParsedCsv): Promise<Validation> {
  const errors: ImportError[] = [];
  const candidates: { row: number; value: z.infer<typeof rowSchema> }[] = [];

  parsed.rows.forEach((raw, idx) => {
    const row = idx + 2; // baris 1 = header
    const r = rowSchema.safeParse(Object.fromEntries(IMPORT_COLUMNS.map((c) => [c, raw[c]])));
    if (r.success) candidates.push({ row, value: r.data });
    else r.error.issues.forEach((i) => errors.push({ row, field: String(i.path[0] ?? ''), message: issueMessage(i) }));
  });

  // duplikat di dalam file
  const firstSeen = new Map<string, number>();
  let pool = candidates.filter((c) => {
    const code = c.value.inventory_code;
    const first = firstSeen.get(code);
    if (first === undefined) {
      firstSeen.set(code, c.row);
      return true;
    }
    errors.push({ row: c.row, field: 'inventory_code', message: `Duplikat dengan baris ${first}` });
    return false;
  });

  // sudah ada di database
  if (pool.length) {
    const existing = await db.equipment.findMany({
      where: { inventory_code: { in: pool.map((c) => c.value.inventory_code) } },
      select: { inventory_code: true },
    });
    const taken = new Set(existing.map((e) => e.inventory_code));
    pool = pool.filter((c) => {
      if (!taken.has(c.value.inventory_code)) return true;
      errors.push({ row: c.row, field: 'inventory_code', message: 'inventory_code sudah terdaftar' });
      return false;
    });
  }

  // ruangan
  const roomList = pool.length
    ? await db.room.findMany({
        where: { room_code: { in: [...new Set(pool.map((c) => c.value.room_code))] } },
        select: { room_id: true, room_code: true, equipment_capacity: true, is_active: true },
      })
    : [];
  const rooms = new Map(roomList.map((r) => [r.room_code, r]));
  const withRoom: ValidRow[] = [];
  for (const c of pool) {
    const { room_code, ...data } = c.value;
    const room = rooms.get(room_code);
    if (!room) errors.push({ row: c.row, field: 'room_code', message: `Ruangan ${room_code} tidak ditemukan` });
    else if (!room.is_active) errors.push({ row: c.row, field: 'room_code', message: `Ruangan ${room_code} tidak aktif` });
    else withRoom.push({ row: c.row, room, data });
  }

  // kapasitas (urut baris)
  const warnings: CapacityWarning[] = [];
  const valid: ValidRow[] = [];
  const state = new Map<string, { used: number; accepted: number; warned: boolean }>();
  for (const v of withRoom) {
    const cap = v.room.equipment_capacity;
    let s = state.get(v.room.room_id);
    if (!s) {
      s = { used: cap > 0 ? await db.equipment.count({ where: { room_id: v.room.room_id, is_active: true } }) : 0, accepted: 0, warned: false };
      state.set(v.room.room_id, s);
    }
    if (cap > 0 && s.used + s.accepted + 1 > cap) {
      if (env.ROOM_CAPACITY_MODE === 'block') {
        errors.push({
          row: v.row,
          field: 'room_code',
          message: `Kapasitas ruangan ${v.room.room_code} terlampaui (kapasitas ${cap}, terpakai ${s.used})`,
        });
        continue;
      }
      if (!s.warned) {
        s.warned = true;
        warnings.push(buildCapacityWarning(v.room, s.used, 0));
      }
    }
    s.accepted++;
    valid.push(v);
  }
  // lengkapi jumlah incoming pada peringatan
  for (const w of warnings) w.incoming = state.get(w.room_id)?.accepted ?? 0;

  errors.sort((a, b) => a.row - b.row);
  return { total: parsed.rows.length, errors, valid, warnings };
}

function summarize(v: Validation, dryRun: boolean, allOrNothing: boolean) {
  const invalidRows = new Set(v.errors.map((e) => e.row)).size;
  return {
    dry_run: dryRun,
    all_or_nothing: allOrNothing,
    total_rows: v.total,
    valid_rows: v.valid.length,
    invalid_rows: invalidRows,
    error_count: v.errors.length,
    errors: v.errors.slice(0, MAX_REPORTED_ERRORS),
    errors_truncated: v.errors.length > MAX_REPORTED_ERRORS,
    warnings: v.warnings,
  };
}

function parseAndCheck(buf: Buffer) {
  const parsed = parseCsv(buf, MAX_IMPORT_ROWS);
  const missing = REQUIRED.filter((c) => !parsed.headers.includes(c));
  if (missing.length) {
    throw new AppError(422, 'INVALID_CSV_HEADER', `Kolom wajib tidak ada: ${missing.join(', ')}`, {
      missing,
      found: parsed.headers,
    });
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

  const roomCodes = [...new Set(parsed.rows.map((r) => (r.room_code ?? '').trim()).filter(Boolean))];

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await db.$transaction(
        async (tx) => {
          // kunci ruangan terkait lalu validasi ulang di dalam transaksi (kapasitas tepat saat commit)
          const rooms = await tx.room.findMany({ where: { room_code: { in: roomCodes } }, select: { room_id: true } });
          await lockRooms(tx, rooms.map((r) => r.room_id));
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
            return { row: r.row, equipment_id: randomUUID(), qr_token: token, room_id: r.room.room_id, ...r.data };
          });

          if (items.length) {
            await tx.equipment.createMany({
              data: items.map(({ row, ...rest }) => {
                void row;
                return rest;
              }),
            });
            await audit.log(
              {
                ...actor,
                action: AUDIT_ACTIONS.IMPORT,
                entityType: AUDIT_ENTITIES.EQUIPMENT,
                newData: {
                  file_name: file.originalname,
                  created_count: items.length,
                  skipped_count: v.total - items.length,
                  inventory_codes: items.slice(0, 500).map((i) => i.inventory_code),
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
                equipment_id: i.equipment_id,
                inventory_code: i.inventory_code,
                qr_token: i.qr_token,
                qr_url: equipmentQrUrl(i.qr_token),
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

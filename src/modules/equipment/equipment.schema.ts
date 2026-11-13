import { z } from 'zod';
import { paginationQuerySchema } from '../../utils/pagination';

export const STATUSES = ['available', 'borrowed', 'damaged', 'maintenance', 'calibration'] as const;
/** `borrowed` hanya diatur oleh proses peminjaman/pengembalian, bukan lewat CRUD. */
export const SETTABLE_STATUSES = ['available', 'damaged', 'maintenance', 'calibration'] as const;
export const CONDITIONS = ['good', 'minor_damage', 'major_damage'] as const;
export const CALIBRATION_STATES = ['safe', 'due_soon', 'overdue'] as const;

const boolQuery = z.enum(['true', 'false']).transform((v) => v === 'true');

/** 'YYYY-MM-DD' → Date UTC (untuk kolom @db.Date). */
export const dateOnlySchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Format tanggal harus YYYY-MM-DD')
  .refine((s) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return true; // sudah dilaporkan oleh regex
    const d = new Date(`${s}T00:00:00.000Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s);
  }, 'Tanggal tidak valid')
  .transform((s) => new Date(`${s}T00:00:00.000Z`));

export const priceSchema = z
  .union([z.number(), z.string().trim().regex(/^\d+(\.\d{1,2})?$/, 'Harga harus angka (maks 2 desimal)')])
  .pipe(z.coerce.number().min(0, 'Harga tidak boleh negatif').max(9_999_999_999_999.99));

export const optText = (max: number) =>
  z.string().trim().max(max).transform((v) => (v === '' ? null : v)).nullable().optional();

/**
 * Kode inventaris/item: diawali huruf/angka (mencegah injeksi rumus CSV seperti `=SUM(1)`), boleh berisi
 * huruf, angka, `.` `_` `-` `/` dan spasi tunggal di tengah (mis. `INV L-ACT 10-01`). Tanpa spasi di ujung
 * dan tanpa spasi ganda.
 */
export const CODE_REGEX = /^[A-Za-z0-9](?:[A-Za-z0-9._\-/]| (?=[A-Za-z0-9._\-/]))*$/;
export const CODE_MESSAGE = 'Hanya huruf, angka, spasi, titik, minus, garis bawah, dan garis miring (tanpa spasi ganda)';

/** Field dasar, dipakai ulang oleh body API dan validasi baris impor CSV. */
export const equipmentFields = {
  inventory_code: z
    .string()
    .trim()
    .min(1, 'wajib diisi')
    .max(50, 'maksimal 50 karakter')
    .regex(CODE_REGEX, CODE_MESSAGE),
  equipment_name: z.string().trim().min(2, 'minimal 2 karakter').max(150),
  equipment_type: z.string().trim().min(2, 'minimal 2 karakter').max(100),
  status: z.enum(SETTABLE_STATUSES),
  condition: z.enum(CONDITIONS),
  useful_life_years: z.number().int().min(1).max(100),
};

export const idParams = z.object({ id: z.string().uuid('ID tidak valid') });

// `qr_token`, `equipment_id`, dsb. tidak ada di skema → otomatis dibuang (diabaikan).
export const createEquipmentBody = z.object({
  inventory_code: equipmentFields.inventory_code,
  equipment_name: equipmentFields.equipment_name,
  equipment_type: equipmentFields.equipment_type,
  brand: optText(100),
  model: optText(100),
  room_id: z.string().uuid('room_id tidak valid'),
  status: equipmentFields.status.default('available'),
  condition: equipmentFields.condition.nullable().default('good'),
  purchase_date: dateOnlySchema.nullable().optional(),
  purchase_price: priceSchema.nullable().optional(),
  useful_life_years: equipmentFields.useful_life_years.nullable().optional(),
  specifications: optText(5000),
  next_calibration_date: dateOnlySchema.nullable().optional(),
});

export const updateEquipmentBody = createEquipmentBody
  .partial()
  .extend({
    status: equipmentFields.status.optional(),
    condition: equipmentFields.condition.nullable().optional(),
    is_active: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Minimal satu field harus diisi' });

const filterShape = {
  status: z.enum(STATUSES).optional(),
  condition: z.enum(CONDITIONS).optional(),
  room_id: z.string().uuid('room_id tidak valid').optional(),
  equipment_type: z.string().trim().min(1).optional(),
  calibration_state: z.enum(CALIBRATION_STATES).optional(),
  is_active: boolQuery.optional(),
};

export const idsParam = z
  .string()
  .trim()
  .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean))
  .pipe(z.array(z.string().uuid('ids harus berisi UUID')).min(1, 'ids kosong').max(1000, 'maksimal 1000 id'));

export const listEquipmentQuery = paginationQuerySchema.extend(filterShape);

/** Ekspor ikut semua filter list (tanpa pagination), atau ?ids=a,b,c. */
export const exportQuery = z.object({
  ...filterShape,
  search: z.string().trim().min(1).optional(),
  ids: idsParam.optional(),
});

export const labelsQuery = z.object({
  ids: idsParam,
  layout: z.enum(['a4-3x8', 'sticker-50x30']).default('a4-3x8'),
});

export const qrQuery = z.object({ size: z.coerce.number().int().min(100).max(1000).default(300) });

export const borrowingsSubQuery = paginationQuerySchema.extend({
  borrowing_status: z.enum(['borrowed', 'returned']).optional(),
});
export const calibrationsSubQuery = paginationQuerySchema.extend({
  calibration_result: z.enum(['passed', 'failed']).optional(),
});
export const maintenancesSubQuery = paginationQuerySchema.extend({
  status: z.enum(['scheduled', 'in_progress', 'completed', 'cancelled']).optional(),
  maintenance_type: z.enum(['routine', 'repair']).optional(),
});
export const documentsSubQuery = paginationQuerySchema.extend({
  document_type: z.enum(['manual', 'certificate', 'procedure', 'photo', 'other']).optional(),
});

const flag = (def: 'true' | 'false') =>
  z.enum(['true', 'false', '1', '0']).default(def).transform((v) => v === 'true' || v === '1');

/** Field multipart/query untuk impor. Default aman: dry_run=true, all_or_nothing=true. */
export const importBody = z.object({ dry_run: flag('true'), all_or_nothing: flag('true') });

export type ListEquipmentQuery = z.infer<typeof listEquipmentQuery>;
export type ExportQuery = z.infer<typeof exportQuery>;
export type CreateEquipmentBody = z.infer<typeof createEquipmentBody>;
export type UpdateEquipmentBody = z.infer<typeof updateEquipmentBody>;
export type ImportBody = z.infer<typeof importBody>;

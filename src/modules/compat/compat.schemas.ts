import { z } from 'zod';
import { passwordSchema } from '../../utils/password';
import { CODE_MESSAGE, CODE_REGEX } from '../equipment/equipment.schema';

/**
 * Skema input yang meniru zod frontend (`lib/schemas/erd.ts`), termasuk pesan error,
 * sehingga `fieldErrors` dari backend dapat dipakai langsung oleh React Hook Form.
 * Perbedaan yang disengaja dari mock ada di komentar masing-masing skema.
 */
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Format tanggal harus yyyy-MM-dd');
const isoDateTime = z.string().refine((v) => !Number.isNaN(Date.parse(v)), 'Tanggal dan waktu tidak valid');
const text = (label: string, max = 200) =>
  z.string().trim().min(1, `${label} wajib diisi`).max(max, `${label} maksimal ${max} karakter`);
const longText = z.string().max(5000, 'Maksimal 5000 karakter');
const id = z.string().min(1);
const nonNegative = (label: string) => z.number().nonnegative(`${label} tidak boleh negatif`);
const positiveInt = (label: string) => z.number().int(`${label} harus bilangan bulat`).min(1, `${label} minimal 1`);

export const ROLES = ['QA', 'admin', 'technician', 'SPV'] as const;
export const CONDITIONS = ['good', 'minor_damage', 'major_damage'] as const;
const role = z.enum(ROLES);
/** Sama dengan aturan backend (`equipment.schema.ts`, `CODE_REGEX`): aman untuk QR, CSV, dan URL. */
const code = (label: string) => text(label, 50).regex(CODE_REGEX, CODE_MESSAGE);
const condition = z.enum(CONDITIONS);

/* ---------- User ---------- */
export const createUserSchema = z
  .object({
    name: text('Nama', 100),
    email: z.string().trim().toLowerCase().email('Email tidak valid'),
    // Memakai aturan password backend (huruf + angka, 8-72) agar tidak ada akun lemah lewat jalur ini.
    password: passwordSchema,
    role,
  })
  .strict();
export const updateUserSchema = z
  .object({
    name: text('Nama', 100),
    email: z.string().trim().toLowerCase().email('Email tidak valid'),
    role,
    is_active: z.boolean(),
  })
  .partial()
  .strict();

/* ---------- Room ---------- */
export const createRoomSchema = z
  .object({
    room_code: text('Kode ruangan', 30),
    room_name: text('Nama ruangan', 100),
    // Backend: 0 = tidak dibatasi (mock: minimal 1). Keduanya diterima.
    equipment_capacity: z.number().int('Kapasitas alat harus bilangan bulat').min(0, 'Kapasitas alat tidak boleh negatif'),
    // Opsional: kosong = tanpa penanggung jawab (kolom DB nullable). Nilai terisi harus UUID user (dicek di route).
    person_in_charge: z.string().trim().optional(),
    description: longText,
  })
  .strict();
export const updateRoomSchema = createRoomSchema.partial();

/* ---------- Equipment ---------- */
const equipmentBase = z.object({
  inventory_code: code('Kode inventaris'),
  equipment_name: text('Nama alat', 150),
  equipment_type: text('Jenis alat', 100),
  brand: text('Merek', 100),
  model: text('Model', 100),
  room_id: text('Ruangan', 50),
  status: z.enum(['available', 'borrowed', 'damaged', 'maintenance', 'calibration']),
  // Keenam field berikut boleh null (tidak diketahui / tidak berlaku); tidak dikirim = null,
  // kecuali condition yang default-nya "good". Alat tanpa next_calibration_date = tidak perlu kalibrasi.
  condition: condition.nullable().optional(),
  purchase_date: isoDate.nullable().optional(),
  purchase_price: nonNegative('Harga beli').nullable().optional(),
  useful_life_years: positiveInt('Masa manfaat').nullable().optional(),
  specifications: longText.nullable().optional(),
  next_calibration_date: isoDate.nullable().optional(),
});
export const createEquipmentSchema = equipmentBase.strict();
export const updateEquipmentSchema = equipmentBase.partial().strict();
export const bulkEquipmentSchema = z.array(createEquipmentSchema).min(1, 'Tidak ada data untuk diimpor').max(1000, 'Maksimal 1000 baris');

/* ---------- Supporting equipment ---------- */
const supportingBase = z.object({
  item_code: code('Kode item'),
  item_name: text('Nama item', 150),
  item_type: text('Jenis item', 100),
  brand: text('Merek', 100),
  model: z.string().trim().max(100),
  unit: text('Satuan', 30),
  total_quantity: positiveInt('Jumlah total'),
  condition,
  description: longText,
  specifications: longText,
});
export const createSupportingSchema = supportingBase.strict();
export const updateSupportingSchema = supportingBase.partial().strict();
export const bulkSupportingSchema = z.array(createSupportingSchema).min(1, 'Tidak ada data untuk diimpor').max(1000, 'Maksimal 1000 baris');

/* ---------- Borrowing ---------- */
export const createBorrowingSchema = z
  .object({
    // Backend selalu mencatat peminjam = pengguna yang login; field ini hanya divalidasi kecocokannya.
    user_id: text('Peminjam', 50),
    // Waktu pinjam ditetapkan server (waktu server = sumber kebenaran); field diterima tetapi diabaikan.
    borrowing_time: isoDateTime.optional(),
    expected_return_time: isoDateTime,
    purpose: text('Tujuan peminjaman', 300),
    usage_location: text('Lokasi penggunaan', 150),
    notes: longText.optional(),
    equipment_ids: z.array(id),
    supporting_items: z.array(z.object({ supporting_equipment_id: id, quantity: positiveInt('Jumlah') })),
  })
  .refine((d) => d.equipment_ids.length + d.supporting_items.length > 0, {
    message: 'Pilih minimal satu alat atau alat pendukung',
    path: ['equipment_ids'],
  });

export const updateBorrowingSchema = z
  .object({
    expected_return_time: isoDateTime,
    purpose: text('Tujuan peminjaman', 300),
    usage_location: text('Lokasi penggunaan', 150),
    notes: longText,
  })
  .partial()
  .strict();

const returnLineBase = {
  // UI mengirim label ("Baik") di sini dan enum di `new_condition`; keduanya diterima.
  final_condition: text('Kondisi akhir', 200),
  has_damage: z.boolean(),
  damage_notes: z.string().trim().max(1000).optional(),
  new_condition: condition.optional(),
};
export const returnBorrowingSchema = z
  .object({
    actual_return_time: isoDateTime.optional(),
    notes: longText.optional(),
    equipment: z.array(z.object({ detail_id: id, ...returnLineBase })),
    supporting: z.array(
      z.object({
        supporting_detail_id: id,
        /** Jumlah yang dikembalikan SAAT INI (bukan kumulatif). */
        quantity_returned_now: z.number().int().min(0),
        ...returnLineBase,
      }),
    ),
  })
  .superRefine((d, ctx) => {
    const check = (lines: { has_damage: boolean; damage_notes?: string; new_condition?: string }[], key: 'equipment' | 'supporting') =>
      lines.forEach((l, i) => {
        if (l.has_damage && !l.damage_notes) ctx.addIssue({ code: 'custom', message: 'Catatan kerusakan wajib diisi', path: [key, i, 'damage_notes'] });
        if (!l.has_damage && l.new_condition && l.new_condition !== 'good') {
          ctx.addIssue({ code: 'custom', message: 'Kondisi tidak baik harus ditandai sebagai kerusakan', path: [key, i, 'has_damage'] });
        }
      });
    check(d.equipment, 'equipment');
    check(d.supporting, 'supporting');
  });

/* ---------- Calibration ---------- */
// technician_id diterima (frontend mengirimnya) tetapi backend mencatat teknisi = pengguna yang login.
const calibrationBase = z.object({
  equipment_id: id,
  technician_id: id.optional(),
  calibration_date: isoDate,
  next_calibration_date: isoDate,
  calibration_provider: text('Penyedia kalibrasi', 150),
  certificate_number: text('Nomor sertifikat', 100),
  calibration_result: z.enum(['passed', 'failed']),
  cost: nonNegative('Biaya'),
  notes: longText,
  /** Sertifikat sebagai data URL (data:application/pdf;base64,...) atau string kosong. */
  certificate_file_url: z.string().optional(),
  /** Status alat bila hasil "failed" (default: calibration). */
  failed_status: z.enum(['calibration', 'damaged']).optional(),
});
export const createCalibrationSchema = calibrationBase.strict().refine((d) => d.next_calibration_date > d.calibration_date, {
  message: 'Tanggal kalibrasi berikutnya harus setelah tanggal kalibrasi',
  path: ['next_calibration_date'],
});

/* ---------- Maintenance ---------- */
const maintenanceBase = z.object({
  equipment_id: id,
  technician_id: id,
  maintenance_type: z.enum(['routine', 'repair']),
  maintenance_date: isoDateTime,
  completion_date: isoDateTime.nullable(),
  description: text('Deskripsi', 2000),
  cost: nonNegative('Biaya'),
  status: z.enum(['scheduled', 'in_progress', 'completed', 'cancelled']),
  replaced_spare_parts: z.string().max(1000),
  notes: longText,
});
export const createMaintenanceSchema = maintenanceBase.strict().refine(
  (d) => !d.completion_date || Date.parse(d.completion_date) >= Date.parse(d.maintenance_date),
  { message: 'Tanggal selesai tidak boleh sebelum tanggal maintenance', path: ['completion_date'] },
);
export const updateMaintenanceSchema = maintenanceBase.partial().strict();

/* ---------- Sensor ---------- */
const sensorBase = z.object({
  room_id: id,
  sensor_code: text('Kode sensor', 50).regex(/^[A-Za-z0-9._-]+$/, 'Hanya huruf, angka, titik, garis bawah, dan strip'),
  sensor_type: z.enum(['temperature', 'humidity']),
  unit: text('Satuan', 20),
  sensor_location: text('Lokasi sensor', 150),
  sensor_status: z.enum(['active', 'inactive', 'damaged']),
  min_threshold: z.number(),
  max_threshold: z.number(),
});
export const createSensorSchema = sensorBase.strict().refine((d) => d.min_threshold < d.max_threshold, {
  message: 'Batas minimum harus lebih kecil dari batas maksimum',
  path: ['min_threshold'],
});
export const updateSensorSchema = sensorBase.partial().strict();

export const createReadingSchema = z.object({ sensor_id: id, value: z.number(), measurement_time: isoDateTime }).strict();

/* ---------- Document (JSON dengan data URL, seperti UI saat ini) ---------- */
export const createDocumentSchema = z
  .object({
    equipment_id: id,
    // Backend mencatat pengunggah = pengguna yang login; field diterima tetapi diabaikan.
    uploaded_by: id.optional(),
    document_type: z.enum(['manual', 'certificate', 'procedure', 'photo', 'other']),
    file_name: text('Nama file', 255),
    /** Data URL base64 hasil FileReader.readAsDataURL. */
    file_url: z.string().min(1, 'File wajib diisi'),
    file_type: z.string().optional(),
    file_size: z.number().optional(),
  })
  .strict();

/* ---------- Notification & laporan ---------- */
export const createNotificationSchema = z
  .object({
    user_id: id,
    borrowing_id: z.string().nullable(),
    calibration_id: z.string().nullable(),
    maintenance_id: z.string().nullable(),
    notification_type: z.enum(['borrowing', 'calibration', 'maintenance', 'monitoring', 'system']),
    title: text('Judul', 150),
    message: z.string().min(1),
    /** Diterima (frontend mengirimnya) tetapi diturunkan server dari entitas terkait. */
    link_url: z.string().nullable().optional(),
  })
  .strict();

export const generateNotificationsSchema = z.object({
  kinds: z.array(z.enum(['calibration', 'overdue', 'temperature', 'damaged'])).min(1, 'Pilih minimal satu jenis'),
});

export const reportIssueSchema = z.object({
  equipment_id: id,
  description: z.string().trim().min(5, 'Jelaskan masalahnya (minimal 5 karakter)').max(1000, 'Maksimal 1000 karakter'),
});

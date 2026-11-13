const sec = [{ bearerAuth: [] }];
const ref = (n: string) => ({ $ref: `#/components/schemas/${n}` });
const json = (schema: unknown) => ({ content: { 'application/json': { schema } } });
const res = (description: string, data?: unknown, meta = false) => ({
  description,
  ...(data
    ? json({ type: 'object', properties: { success: { type: 'boolean', example: true }, data, ...(meta ? { meta: ref('PageMeta') } : {}) } })
    : {}),
});
const err = (description: string) => ({ description, ...json(ref('ErrorResponse')) });
const q = (name: string, schema: unknown, description?: string) => ({ name, in: 'query', schema, ...(description ? { description } : {}) });
const idParam = { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } };
const paging = [
  q('page', { type: 'integer', default: 1 }),
  q('limit', { type: 'integer', default: 10, maximum: 100 }),
  q('order', { type: 'string', enum: ['asc', 'desc'] }),
];
const file = (description: string, mime: string) => ({ description, content: { [mime]: { schema: { type: 'string', format: 'binary' } } } });

const STATUS = ['available', 'borrowed', 'damaged', 'maintenance', 'calibration'];
const COND = ['good', 'minor_damage', 'major_damage'];
const filters = [
  q('status', { type: 'string', enum: STATUS }),
  q('condition', { type: 'string', enum: COND }),
  q('room_id', { type: 'string', format: 'uuid' }),
  q('equipment_type', { type: 'string' }),
  q('calibration_state', { type: 'string', enum: ['safe', 'due_soon', 'overdue'] }, 'due_soon = jatuh tempo dalam CALIBRATION_DUE_SOON_DAYS hari (default 30)'),
  q('is_active', { type: 'boolean' }),
  q('search', { type: 'string' }, 'nama atau inventory_code'),
];

export const roomsEquipmentTags = [
  { name: 'Rooms' },
  { name: 'Equipment' },
  { name: 'Equipment Export/Import' },
];

export const roomsEquipmentSchemas = {
  CapacityWarning: {
    type: 'object',
    properties: {
      code: { type: 'string', example: 'ROOM_CAPACITY_EXCEEDED' },
      message: { type: 'string' },
      room_id: { type: 'string', format: 'uuid' },
      room_code: { type: 'string' },
      capacity: { type: 'integer' },
      used: { type: 'integer' },
      incoming: { type: 'integer' },
    },
  },
  Room: {
    type: 'object',
    properties: {
      room_id: { type: 'string', format: 'uuid' },
      room_code: { type: 'string' },
      room_name: { type: 'string' },
      equipment_capacity: { type: 'integer', description: '0 = tidak dibatasi' },
      person_in_charge: { type: 'string', format: 'uuid', nullable: true },
      description: { type: 'string', nullable: true },
      is_active: { type: 'boolean' },
      pic: { type: 'object', nullable: true, properties: { user_id: { type: 'string' }, name: { type: 'string' }, email: { type: 'string' } } },
      active_equipment_count: { type: 'integer' },
      capacity: {
        type: 'object',
        properties: {
          total: { type: 'integer' }, used: { type: 'integer' }, remaining: { type: 'integer', nullable: true },
          usage_percent: { type: 'number', nullable: true }, is_unlimited: { type: 'boolean' }, is_over_capacity: { type: 'boolean' },
        },
      },
      latest_readings: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            sensor_id: { type: 'string' }, sensor_code: { type: 'string' }, sensor_type: { type: 'string', enum: ['temperature', 'humidity'] },
            unit: { type: 'string' }, value: { type: 'number', nullable: true }, measurement_time: { type: 'string', format: 'date-time', nullable: true },
            min_threshold: { type: 'number' }, max_threshold: { type: 'number' },
            threshold_state: { type: 'string', enum: ['normal', 'below_min', 'above_max'], nullable: true },
          },
        },
      },
      created_at: { type: 'string', format: 'date-time' },
      updated_at: { type: 'string', format: 'date-time' },
    },
  },
  RoomInput: {
    type: 'object',
    required: ['room_code', 'room_name'],
    properties: {
      room_code: { type: 'string' }, room_name: { type: 'string' }, equipment_capacity: { type: 'integer', default: 0 },
      person_in_charge: { type: 'string', format: 'uuid', nullable: true }, description: { type: 'string', nullable: true },
      is_active: { type: 'boolean', description: 'Hanya PATCH' },
    },
  },
  Equipment: {
    type: 'object',
    properties: {
      equipment_id: { type: 'string', format: 'uuid' },
      inventory_code: { type: 'string' },
      qr_token: { type: 'string', description: '12 karakter, dibuat server, tidak pernah berubah' },
      qr_url: { type: 'string', example: 'http://localhost:3001/scan/eq/Ab3dE5gH7jK9' },
      equipment_name: { type: 'string' }, equipment_type: { type: 'string' }, brand: { type: 'string', nullable: true }, model: { type: 'string', nullable: true },
      room_id: { type: 'string', format: 'uuid' },
      room: { type: 'object', properties: { room_id: { type: 'string' }, room_code: { type: 'string' }, room_name: { type: 'string' } } },
      status: { type: 'string', enum: STATUS }, condition: { type: 'string', enum: COND, nullable: true, description: 'null = belum diketahui; tidak dikirim saat dibuat = good' },
      purchase_date: { type: 'string', format: 'date', nullable: true },
      purchase_price: { type: 'number', nullable: true, example: 45000000 },
      useful_life_years: { type: 'integer', nullable: true },
      specifications: { type: 'string', nullable: true },
      next_calibration_date: { type: 'string', format: 'date', nullable: true },
      calibration_state: { type: 'string', enum: ['safe', 'due_soon', 'overdue'], nullable: true, description: 'null jika tidak ada jadwal kalibrasi' },
      remaining_useful_life_years: { type: 'number', nullable: true, description: 'Tahun, min 0; null jika purchase_date/useful_life_years kosong' },
      is_active: { type: 'boolean' },
      warnings: { type: 'array', items: ref('CapacityWarning'), description: 'Ada jika ROOM_CAPACITY_MODE=warn dan kapasitas terlampaui' },
      created_at: { type: 'string', format: 'date-time' }, updated_at: { type: 'string', format: 'date-time' },
    },
  },
  EquipmentInput: {
    type: 'object',
    required: ['inventory_code', 'equipment_name', 'equipment_type', 'room_id'],
    description: 'qr_token pada body diabaikan.',
    properties: {
      inventory_code: { type: 'string' }, equipment_name: { type: 'string' }, equipment_type: { type: 'string' },
      brand: { type: 'string' }, model: { type: 'string' }, room_id: { type: 'string', format: 'uuid' },
      status: { type: 'string', enum: ['available', 'damaged', 'maintenance', 'calibration'] }, condition: { type: 'string', enum: COND, nullable: true },
      purchase_date: { type: 'string', format: 'date' }, purchase_price: { type: 'number' }, useful_life_years: { type: 'integer' },
      specifications: { type: 'string' }, next_calibration_date: { type: 'string', format: 'date' },
      is_active: { type: 'boolean', description: 'Hanya PATCH' },
    },
  },
  ImportResult: {
    type: 'object',
    properties: {
      dry_run: { type: 'boolean' }, all_or_nothing: { type: 'boolean' }, total_rows: { type: 'integer' }, valid_rows: { type: 'integer' },
      invalid_rows: { type: 'integer' }, error_count: { type: 'integer' }, errors_truncated: { type: 'boolean' },
      errors: { type: 'array', items: { type: 'object', properties: { row: { type: 'integer', description: 'Header = baris 1' }, field: { type: 'string' }, message: { type: 'string' } } } },
      warnings: { type: 'array', items: ref('CapacityWarning') },
      would_create: { type: 'integer', description: 'Hanya dry_run' },
      created_count: { type: 'integer' }, skipped_count: { type: 'integer' },
      created: { type: 'array', items: { type: 'object', properties: { row: { type: 'integer' }, equipment_id: { type: 'string' }, inventory_code: { type: 'string' }, qr_token: { type: 'string' }, qr_url: { type: 'string' } } } },
    },
  },
};

export const roomsEquipmentPaths = {
  '/rooms': {
    get: {
      tags: ['Rooms'], summary: 'Daftar ruangan + jumlah alat aktif, kapasitas terpakai, pembacaan sensor terbaru', security: sec,
      parameters: [...paging, q('sort', { type: 'string', enum: ['room_code', 'room_name', 'equipment_capacity', 'is_active', 'created_at', 'updated_at'] }), q('search', { type: 'string' }), q('is_active', { type: 'boolean' }), q('person_in_charge', { type: 'string', format: 'uuid' })],
      responses: { '200': res('OK', { type: 'array', items: ref('Room') }, true) },
    },
    post: {
      tags: ['Rooms'], summary: 'Buat ruangan (admin, SPV)', security: sec,
      requestBody: { required: true, ...json(ref('RoomInput')) },
      responses: { '201': res('Dibuat', ref('Room')), '409': err('room_code ganda'), '422': err('Validasi gagal') },
    },
  },
  '/rooms/{id}': {
    get: { tags: ['Rooms'], summary: 'Detail ruangan', security: sec, parameters: [idParam], responses: { '200': res('OK', ref('Room')), '404': err('Tidak ditemukan') } },
    patch: {
      tags: ['Rooms'], summary: 'Ubah ruangan (admin, SPV). Mengecilkan kapasitas di bawah jumlah alat aktif → 409/peringatan sesuai ROOM_CAPACITY_MODE', security: sec, parameters: [idParam],
      requestBody: { required: true, ...json(ref('RoomInput')) },
      responses: { '200': res('OK', ref('Room')), '409': err('room_code ganda / kapasitas / ruangan masih berisi') },
    },
    delete: { tags: ['Rooms'], summary: 'Nonaktifkan ruangan (soft delete); 409 ROOM_NOT_EMPTY jika masih ada alat/sensor aktif', security: sec, parameters: [idParam], responses: { '200': res('OK', ref('Room')), '409': err('Ruangan masih berisi') } },
  },
  '/equipment': {
    get: {
      tags: ['Equipment'], summary: 'Daftar equipment', security: sec,
      parameters: [...paging, q('sort', { type: 'string', enum: ['equipment_name', 'inventory_code', 'equipment_type', 'status', 'condition', 'next_calibration_date', 'purchase_date', 'created_at', 'updated_at'] }), ...filters],
      responses: { '200': res('OK', { type: 'array', items: ref('Equipment') }, true) },
    },
    post: {
      tags: ['Equipment'], summary: 'Buat equipment (admin, SPV); qr_token & qr_url dibuat otomatis', security: sec,
      requestBody: { required: true, ...json(ref('EquipmentInput')) },
      responses: { '201': res('Dibuat', ref('Equipment')), '409': err('inventory_code ganda / ROOM_CAPACITY_EXCEEDED'), '422': err('Validasi gagal / ruangan tidak valid') },
    },
  },
  '/equipment/{id}': {
    get: { tags: ['Equipment'], summary: 'Detail + ruangan + peminjaman aktif + documents_count', security: sec, parameters: [idParam], responses: { '200': res('OK', ref('Equipment')), '404': err('Tidak ditemukan') } },
    patch: {
      tags: ['Equipment'], summary: 'Ubah equipment. qr_token tidak pernah berubah; inventory_code hanya oleh role yang diizinkan', security: sec, parameters: [idParam],
      requestBody: { required: true, ...json(ref('EquipmentInput')) },
      responses: { '200': res('OK', ref('Equipment')), '409': err('Ganda / kapasitas / sedang dipinjam') },
    },
    delete: { tags: ['Equipment'], summary: 'Soft delete; 409 jika sedang dipinjam', security: sec, parameters: [idParam], responses: { '200': res('OK', ref('Equipment')), '409': err('EQUIPMENT_BORROWED') } },
  },
  '/equipment/{id}/qr.png': {
    get: {
      tags: ['Equipment'], summary: 'Gambar QR PNG (error correction M), tidak disimpan. Butuh header Authorization → ambil via fetch lalu blob', security: sec,
      parameters: [idParam, q('size', { type: 'integer', minimum: 100, maximum: 1000, default: 300 })],
      responses: { '200': file('PNG', 'image/png') },
    },
  },
  '/equipment/{id}/borrowings': { get: { tags: ['Equipment'], summary: 'Riwayat peminjaman alat', security: sec, parameters: [idParam, ...paging, q('sort', { type: 'string', enum: ['borrowing_time', 'expected_return_time'] }), q('borrowing_status', { type: 'string', enum: ['borrowed', 'returned'] })], responses: { '200': res('OK', { type: 'array', items: { type: 'object' } }, true) } } },
  '/equipment/{id}/calibrations': { get: { tags: ['Equipment'], summary: 'Riwayat kalibrasi alat', security: sec, parameters: [idParam, ...paging, q('sort', { type: 'string', enum: ['calibration_date', 'next_calibration_date', 'created_at'] }), q('calibration_result', { type: 'string', enum: ['passed', 'failed'] })], responses: { '200': res('OK', { type: 'array', items: { type: 'object' } }, true) } } },
  '/equipment/{id}/maintenances': { get: { tags: ['Equipment'], summary: 'Riwayat maintenance alat', security: sec, parameters: [idParam, ...paging, q('sort', { type: 'string', enum: ['maintenance_date', 'completion_date', 'created_at'] }), q('status', { type: 'string', enum: ['scheduled', 'in_progress', 'completed', 'cancelled'] }), q('maintenance_type', { type: 'string', enum: ['routine', 'repair'] })], responses: { '200': res('OK', { type: 'array', items: { type: 'object' } }, true) } } },
  '/equipment/{id}/documents': { get: { tags: ['Equipment'], summary: 'Dokumen alat', security: sec, parameters: [idParam, ...paging, q('sort', { type: 'string', enum: ['uploaded_at', 'file_name', 'document_type'] }), q('document_type', { type: 'string', enum: ['manual', 'certificate', 'procedure', 'photo', 'other'] })], responses: { '200': res('OK', { type: 'array', items: { type: 'object' } }, true) } } },
  '/equipment/export.csv': {
    get: { tags: ['Equipment Export/Import'], summary: 'Ekspor CSV (UTF-8 + BOM, streaming). Ikut filter list atau ?ids=a,b,c', security: sec, parameters: [...filters, q('ids', { type: 'string' }, 'UUID dipisah koma')], responses: { '200': file('CSV', 'text/csv') } },
  },
  '/equipment/export.zip': {
    get: { tags: ['Equipment Export/Import'], summary: 'ZIP berisi equipment.csv + qr/{inventory_code}.png (streaming)', security: sec, parameters: [...filters, q('ids', { type: 'string' })], responses: { '200': file('ZIP', 'application/zip') } },
  },
  '/equipment/labels.pdf': {
    get: {
      tags: ['Equipment Export/Import'], summary: 'PDF label (QR + nama + kode)', security: sec,
      parameters: [q('ids', { type: 'string' }, 'UUID dipisah koma (wajib, maks 1000)'), q('layout', { type: 'string', enum: ['a4-3x8', 'sticker-50x30'], default: 'a4-3x8' })],
      responses: { '200': file('PDF', 'application/pdf'), '404': err('Sebagian id tidak ditemukan') },
    },
  },
  '/equipment/import-template.csv': { get: { tags: ['Equipment Export/Import'], summary: 'Template CSV impor (admin, SPV)', security: sec, responses: { '200': file('CSV', 'text/csv') } } },
  '/equipment/import': {
    post: {
      tags: ['Equipment Export/Import'],
      summary: 'Impor CSV (multipart, field `file`, maks 2 MB / 1000 baris). Default dry_run=true & all_or_nothing=true',
      security: sec,
      requestBody: {
        required: true,
        content: {
          'multipart/form-data': {
            schema: {
              type: 'object', required: ['file'],
              properties: {
                file: { type: 'string', format: 'binary' },
                dry_run: { type: 'boolean', default: true, description: 'true = validasi saja' },
                all_or_nothing: { type: 'boolean', default: true, description: 'true = tolak semua jika ada baris error; false = simpan baris valid saja' },
              },
            },
          },
        },
      },
      responses: { '200': res('Hasil dry run / tidak ada baris tersimpan', ref('ImportResult')), '201': res('Tersimpan', ref('ImportResult')), '413': err('File terlalu besar'), '422': err('IMPORT_VALIDATION_FAILED / INVALID_CSV / INVALID_CSV_HEADER') },
    },
  },
};

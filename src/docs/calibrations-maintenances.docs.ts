const sec = [{ bearerAuth: [] }];
const ref = (n: string) => ({ $ref: `#/components/schemas/${n}` });
const json = (schema: unknown) => ({ content: { 'application/json': { schema } } });
const res = (description: string, data?: unknown, meta = false) => ({
  description,
  ...(data ? json({ type: 'object', properties: { success: { type: 'boolean', example: true }, data, ...(meta ? { meta: ref('PageMeta') } : {}) } }) : {}),
});
const err = (description: string) => ({ description, ...json(ref('ErrorResponse')) });
const q = (name: string, schema: unknown, description?: string) => ({ name, in: 'query', schema, ...(description ? { description } : {}) });
const idParam = { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } };
const paging = [q('page', { type: 'integer', default: 1 }), q('limit', { type: 'integer', default: 10, maximum: 100 }), q('order', { type: 'string', enum: ['asc', 'desc'] }), q('search', { type: 'string' })];
const MSTATUS = ['scheduled', 'in_progress', 'completed', 'cancelled'];

export const calibrationsMaintenancesTags = [{ name: 'Calibrations' }, { name: 'Maintenances' }];

export const calibrationsMaintenancesSchemas = {
  Calibration: {
    type: 'object',
    properties: {
      calibration_id: { type: 'string', format: 'uuid' }, equipment_id: { type: 'string', format: 'uuid' }, technician_id: { type: 'string', format: 'uuid' },
      calibration_date: { type: 'string', format: 'date' }, next_calibration_date: { type: 'string', format: 'date' },
      calibration_provider: { type: 'string', nullable: true }, certificate_number: { type: 'string', nullable: true },
      calibration_result: { type: 'string', enum: ['passed', 'failed'] }, cost: { type: 'number', nullable: true }, notes: { type: 'string', nullable: true },
      has_certificate: { type: 'boolean' }, certificate_download_path: { type: 'string', nullable: true },
      technician: { type: 'object' }, equipment: { type: 'object', description: 'Ringkasan alat + calibration_state saat ini' },
      applied_to_equipment: { type: 'boolean', description: 'Hanya respons POST. false = entri lama (riwayat saja), jadwal/status alat tidak diubah' },
    },
  },
  CalibrationInput: {
    type: 'object',
    required: ['equipment_id', 'calibration_date', 'next_calibration_date', 'calibration_result'],
    description: 'multipart/form-data. Sertifikat opsional di field `certificate` (PDF/JPEG/PNG/WebP, maks CERTIFICATE_MAX_MB; isi file diverifikasi).',
    properties: {
      equipment_id: { type: 'string', format: 'uuid' }, calibration_date: { type: 'string', format: 'date', description: 'Tidak boleh di masa depan' },
      next_calibration_date: { type: 'string', format: 'date', description: 'Harus setelah calibration_date' },
      calibration_result: { type: 'string', enum: ['passed', 'failed'] },
      status_after_fail: { type: 'string', enum: ['calibration', 'damaged'], default: 'calibration', description: 'Hanya untuk failed' },
      calibration_provider: { type: 'string' }, certificate_number: { type: 'string' }, cost: { type: 'number' }, notes: { type: 'string' },
      certificate: { type: 'string', format: 'binary' },
    },
  },
  Maintenance: {
    type: 'object',
    properties: {
      maintenance_id: { type: 'string', format: 'uuid' }, equipment_id: { type: 'string', format: 'uuid' }, technician_id: { type: 'string', format: 'uuid' },
      maintenance_type: { type: 'string', enum: ['routine', 'repair'] }, maintenance_date: { type: 'string', format: 'date-time' },
      completion_date: { type: 'string', format: 'date-time', nullable: true }, description: { type: 'string', nullable: true }, cost: { type: 'number', nullable: true },
      status: { type: 'string', enum: MSTATUS }, replaced_spare_parts: { type: 'string', nullable: true }, notes: { type: 'string', nullable: true },
      prev_equipment_status: { type: 'string', nullable: true, description: 'Status alat sebelum in_progress (internal, untuk pembatalan)' },
      equipment: { type: 'object' }, technician: { type: 'object' },
      equipment_status_after: { type: 'string', description: 'Hanya respons PATCH yang mengubah status alat' },
    },
  },
  MaintenanceInput: {
    type: 'object', required: ['equipment_id', 'maintenance_type', 'maintenance_date'],
    properties: {
      equipment_id: { type: 'string', format: 'uuid' }, technician_id: { type: 'string', format: 'uuid', description: 'Default: user login' },
      maintenance_type: { type: 'string', enum: ['routine', 'repair'] }, maintenance_date: { type: 'string', example: '2026-11-05T09:00:00Z', description: 'ISO 8601 dengan zona waktu, atau YYYY-MM-DD' },
      description: { type: 'string' }, cost: { type: 'number' }, replaced_spare_parts: { type: 'string' }, notes: { type: 'string' },
    },
  },
  MaintenanceUpdate: {
    type: 'object', description: 'Semua field opsional (equipment_id tidak bisa diubah). Status final (completed/cancelled) tidak dapat diubah lagi (409).',
    properties: {
      status: { type: 'string', enum: MSTATUS, description: 'scheduled→in_progress→completed; cancelled dari scheduled/in_progress; selain itu 422 INVALID_TRANSITION' },
      completion_date: { type: 'string', description: 'Hanya saat → completed (default: sekarang)' },
      equipment_damaged: { type: 'boolean', description: 'Hanya saat → completed: true = alat damaged, false/kosong = available' },
      technician_id: { type: 'string', format: 'uuid' }, maintenance_type: { type: 'string', enum: ['routine', 'repair'] }, maintenance_date: { type: 'string' },
      description: { type: 'string' }, cost: { type: 'number', nullable: true }, replaced_spare_parts: { type: 'string' }, notes: { type: 'string' },
    },
  },
};

const calFilters = [
  q('equipment_id', { type: 'string', format: 'uuid' }),
  q('result', { type: 'string', enum: ['passed', 'failed'] }),
  q('state', { type: 'string', enum: ['safe', 'due_soon', 'overdue'] }, 'Status jadwal kalibrasi alat SAAT INI (bukan status entri riwayat)'),
  q('date_from', { type: 'string', format: 'date' }), q('date_to', { type: 'string', format: 'date' }),
  q('sort', { type: 'string', enum: ['calibration_date', 'next_calibration_date', 'created_at', 'calibration_result'] }),
];

export const calibrationsMaintenancesPaths = {
  '/calibrations': {
    get: { tags: ['Calibrations'], summary: 'Daftar kalibrasi', security: sec, parameters: [...paging, ...calFilters], responses: { '200': res('OK', { type: 'array', items: ref('Calibration') }, true) } },
    post: {
      tags: ['Calibrations'], summary: 'Catat kalibrasi (admin/SPV/technician). passed → update next_calibration_date alat & status calibration→available; failed → status alat calibration/damaged', security: sec,
      requestBody: { required: true, content: { 'multipart/form-data': { schema: ref('CalibrationInput') } } },
      responses: { '201': res('Dibuat', ref('Calibration')), '409': err('EQUIPMENT_BORROWED / EQUIPMENT_IN_MAINTENANCE / EQUIPMENT_INACTIVE'), '413': err('Sertifikat terlalu besar'), '422': err('Validasi gagal / tipe file tidak sesuai') },
    },
  },
  '/calibrations/schedule': {
    get: { tags: ['Calibrations'], summary: 'Kalender: alat aktif jatuh tempo pada bulan tertentu, dikelompokkan per tanggal', security: sec, parameters: [q('month', { type: 'string', example: '2026-11' }), q('room_id', { type: 'string', format: 'uuid' })], responses: { '200': res('OK', { type: 'object', properties: { month: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' }, total: { type: 'integer' }, days: { type: 'array', items: { type: 'object' } } } }) } },
  },
  '/calibrations/summary': {
    get: { tags: ['Calibrations'], summary: 'Jumlah alat aktif per calibration_state', security: sec, parameters: [q('room_id', { type: 'string', format: 'uuid' })], responses: { '200': res('OK', { type: 'object', properties: { safe: { type: 'integer' }, due_soon: { type: 'integer' }, overdue: { type: 'integer' }, no_schedule: { type: 'integer' }, total_scheduled: { type: 'integer' } } }) } },
  },
  '/calibrations/{id}': { get: { tags: ['Calibrations'], summary: 'Detail kalibrasi', security: sec, parameters: [idParam], responses: { '200': res('OK', ref('Calibration')), '404': err('Tidak ditemukan') } } },
  '/calibrations/{id}/certificate': {
    get: { tags: ['Calibrations'], summary: 'Unduh sertifikat (login + hak baca). Butuh header Authorization → fetch lalu blob', security: sec, parameters: [idParam], responses: { '200': { description: 'File', content: { 'application/pdf': { schema: { type: 'string', format: 'binary' } }, 'image/*': { schema: { type: 'string', format: 'binary' } } } }, '404': err('Tidak ada sertifikat / file hilang') } },
  },
  '/equipment/{id}/start-calibration': {
    post: { tags: ['Calibrations'], summary: 'Mulai kalibrasi: status alat → calibration (admin/SPV/technician). 409 jika borrowed/maintenance/sudah calibration/nonaktif', security: sec, parameters: [idParam], responses: { '200': res('OK', { type: 'object' }), '409': err('EQUIPMENT_BORROWED dll.') } },
  },
  '/maintenances': {
    get: {
      tags: ['Maintenances'], summary: 'Daftar maintenance', security: sec,
      parameters: [...paging, q('maintenance_type', { type: 'string', enum: ['routine', 'repair'] }), q('status', { type: 'string', enum: MSTATUS }), q('equipment_id', { type: 'string', format: 'uuid' }), q('technician_id', { type: 'string', format: 'uuid' }), q('date_from', { type: 'string', format: 'date' }), q('date_to', { type: 'string', format: 'date' }), q('sort', { type: 'string', enum: ['maintenance_date', 'completion_date', 'created_at', 'status', 'maintenance_type'] })],
      responses: { '200': res('OK', { type: 'array', items: ref('Maintenance') }, true) },
    },
    post: { tags: ['Maintenances'], summary: 'Jadwalkan maintenance (status awal scheduled)', security: sec, requestBody: { required: true, ...json(ref('MaintenanceInput')) }, responses: { '201': res('Dibuat', ref('Maintenance')), '409': err('EQUIPMENT_INACTIVE'), '422': err('Validasi gagal') } },
  },
  '/maintenances/{id}': {
    get: { tags: ['Maintenances'], summary: 'Detail maintenance', security: sec, parameters: [idParam], responses: { '200': res('OK', ref('Maintenance')), '404': err('Tidak ditemukan') } },
    patch: {
      tags: ['Maintenances'], summary: 'Ubah data / pindahkan status (mesin status). in_progress → alat maintenance; completed → alat available (atau damaged); cancelled → kembalikan status sebelumnya', security: sec, parameters: [idParam],
      requestBody: { required: true, ...json(ref('MaintenanceUpdate')) },
      responses: { '200': res('OK', ref('Maintenance')), '409': err('MAINTENANCE_LOCKED / EQUIPMENT_BORROWED / EQUIPMENT_IN_CALIBRATION / EQUIPMENT_IN_MAINTENANCE'), '422': err('INVALID_TRANSITION / validasi') },
    },
    delete: { tags: ['Maintenances'], summary: 'Hapus (admin/SPV), hanya yang masih scheduled', security: sec, parameters: [idParam], responses: { '200': res('OK', ref('Maintenance')), '409': err('MAINTENANCE_NOT_DELETABLE') } },
  },
};

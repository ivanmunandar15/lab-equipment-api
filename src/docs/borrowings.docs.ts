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
const paging = [q('page', { type: 'integer', default: 1 }), q('limit', { type: 'integer', default: 10, maximum: 100 }), q('order', { type: 'string', enum: ['asc', 'desc'] })];
const COND = ['good', 'minor_damage', 'major_damage'];
const T = 'Borrowings';

export const borrowingsTags = [{ name: 'Scan' }, { name: T }];

const listFilters = [
  q('status', { type: 'string', enum: ['active', 'overdue', 'returned'] }, 'active = masih dipinjam (termasuk overdue); overdue = dipinjam & melewati expected_return_time'),
  q('equipment_id', { type: 'string', format: 'uuid' }),
  q('date_from', { type: 'string', format: 'date' }, 'berdasarkan borrowing_time'),
  q('date_to', { type: 'string', format: 'date' }, 'inklusif sampai akhir hari UTC'),
  q('search', { type: 'string' }, 'purpose / usage_location'),
  q('sort', { type: 'string', enum: ['borrowing_time', 'expected_return_time', 'actual_return_time', 'created_at'] }),
];

export const borrowingsSchemas = {
  ScanResult: {
    type: 'object',
    description: 'Data terbaru alat/barang (sama dengan detail) + blok aksi yang dihitung server.',
    properties: {
      type: { type: 'string', enum: ['equipment', 'supporting'] },
      available_actions: { type: 'array', items: { type: 'string', enum: ['borrow', 'return', 'report_damage'] }, example: ['borrow', 'report_damage'] },
      reason: { type: 'string', nullable: true, description: 'Alasan jika tidak ada aksi utama (borrow/return)' },
      warnings: { type: 'array', items: { type: 'string', enum: ['calibration_overdue'] } },
      active_borrowing: { type: 'object', nullable: true, description: 'Equipment: peminjam aktif, borrowing_time, expected_return_time, is_overdue, can_return, detail_id' },
      active_borrowings: { type: 'array', items: { type: 'object' }, description: 'Supporting: daftar pinjaman aktif (+can_return, supporting_detail_id)' },
      max_borrow_quantity: { type: 'integer', description: 'Supporting saja' },
      server_time: { type: 'string', format: 'date-time' },
    },
  },
  BorrowingProblem: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: ['equipment', 'supporting'] }, index: { type: 'integer', description: 'Posisi pada array request' },
      reason: { type: 'string', enum: ['NOT_FOUND', 'INACTIVE', 'NOT_AVAILABLE', 'CALIBRATION_OVERDUE', 'DAMAGED', 'INSUFFICIENT_STOCK'] },
      message: { type: 'string' }, code: { type: 'string' }, name: { type: 'string' }, status: { type: 'string' },
      requested: { type: 'integer' }, available: { type: 'integer' },
    },
  },
  Borrowing: {
    type: 'object',
    properties: {
      borrowing_id: { type: 'string', format: 'uuid' }, user_id: { type: 'string', format: 'uuid' },
      borrowing_time: { type: 'string', format: 'date-time' }, expected_return_time: { type: 'string', format: 'date-time' },
      actual_return_time: { type: 'string', format: 'date-time', nullable: true, description: 'Terisi saat SEMUA item selesai dikembalikan' },
      purpose: { type: 'string' }, usage_location: { type: 'string', nullable: true }, notes: { type: 'string', nullable: true },
      borrowing_status: { type: 'string', enum: ['borrowed', 'returned'] },
      is_overdue: { type: 'boolean', description: 'Dihitung: borrowed & expected_return_time < sekarang' },
      user: { type: 'object' }, equipment_count: { type: 'integer' }, supporting_count: { type: 'integer' },
    },
  },
  BorrowingDetail: {
    type: 'object',
    properties: {
      borrowing_id: { type: 'string' }, borrowing_status: { type: 'string' }, is_overdue: { type: 'boolean' }, can_return: { type: 'boolean' },
      user: { type: 'object' }, summary: { type: 'object' },
      equipment: { type: 'array', items: { type: 'object', description: '{detail_id, equipment, initial_condition, final_condition, has_damage, damage_notes, is_returned}' } },
      supporting: { type: 'array', items: { type: 'object', description: '{supporting_detail_id, item, quantity_borrowed, quantity_returned, quantity_outstanding, ..., is_returned}' } },
      warnings: { type: 'array', items: { type: 'object' }, description: 'Hanya respons POST: calibration_overdue' },
      completed: { type: 'boolean', description: 'Hanya respons return' },
    },
  },
  BorrowingInput: {
    type: 'object',
    required: ['purpose', 'expected_return_time'],
    description: 'Minimal satu alat atau barang pendukung. Tiap item: equipment_id ATAU qr_token.',
    properties: {
      purpose: { type: 'string' }, usage_location: { type: 'string' }, notes: { type: 'string' },
      expected_return_time: { type: 'string', format: 'date-time', example: '2026-11-02T09:00:00Z' },
      equipment: { type: 'array', items: { type: 'object', properties: { equipment_id: { type: 'string', format: 'uuid' }, qr_token: { type: 'string' } } } },
      supporting: { type: 'array', items: { type: 'object', required: ['quantity'], properties: { supporting_equipment_id: { type: 'string', format: 'uuid' }, qr_token: { type: 'string' }, quantity: { type: 'integer', minimum: 1 } } } },
    },
  },
  ReturnInput: {
    type: 'object',
    description: 'Pengembalian sebagian didukung. quantity_returned = jumlah yang dikembalikan pada panggilan ini.',
    properties: {
      items: { type: 'array', items: { type: 'object', required: ['detail_id', 'final_condition'], properties: { detail_id: { type: 'string', format: 'uuid' }, final_condition: { type: 'string', enum: COND }, has_damage: { type: 'boolean', default: false }, damage_notes: { type: 'string' } } } },
      supporting: { type: 'array', items: { type: 'object', required: ['supporting_detail_id', 'quantity_returned'], properties: { supporting_detail_id: { type: 'string', format: 'uuid' }, quantity_returned: { type: 'integer', minimum: 1 }, final_condition: { type: 'string', enum: COND, default: 'good' }, has_damage: { type: 'boolean' }, damage_notes: { type: 'string' } } } },
    },
  },
};

const scanPath = (kind: 'eq' | 'sp', label: string) => ({
  get: {
    tags: ['Scan'], summary: `Scan QR ${label}: data terbaru + available_actions (tanpa cache)`, security: sec,
    parameters: [{ name: 'qrToken', in: 'path', required: true, schema: { type: 'string' } }],
    responses: { '200': res('OK', ref('ScanResult')), '404': err('QR tidak dikenali'), '410': err(`${kind === 'eq' ? 'Alat' : 'Item'} sudah dinonaktifkan`) },
  },
});

export const borrowingsPaths = {
  '/scan/eq/{qrToken}': scanPath('eq', 'alat'),
  '/scan/sp/{qrToken}': scanPath('sp', 'barang pendukung'),
  '/borrowings': {
    get: { tags: [T], summary: 'Daftar peminjaman', security: sec, parameters: [...paging, ...listFilters, q('user_id', { type: 'string', format: 'uuid' })], responses: { '200': res('OK', { type: 'array', items: ref('Borrowing') }, true) } },
    post: {
      tags: [T], summary: 'Pinjam (mode keranjang). Atomik: satu item gagal → semua dibatalkan (409 BORROWING_CONFLICT + daftar item)', security: sec,
      requestBody: { required: true, ...json(ref('BorrowingInput')) },
      responses: { '201': res('Dibuat', ref('BorrowingDetail')), '409': { description: 'BORROWING_CONFLICT; details.items = [BorrowingProblem]', ...json(ref('ErrorResponse')) }, '422': err('Validasi gagal / item duplikat') },
    },
  },
  '/borrowings/my': { get: { tags: [T], summary: 'Peminjaman milik user login', security: sec, parameters: [...paging, ...listFilters], responses: { '200': res('OK', { type: 'array', items: ref('Borrowing') }, true) } } },
  '/borrowings/{id}': { get: { tags: [T], summary: 'Detail lengkap semua item', security: sec, parameters: [idParam], responses: { '200': res('OK', ref('BorrowingDetail')), '404': err('Tidak ditemukan') } } },
  '/borrowings/{id}/return': {
    post: {
      tags: [T], summary: 'Kembalikan (sebagian/seluruh). Hanya peminjam, admin, SPV. Kerusakan → alat damaged + notifikasi SPV/technician', security: sec, parameters: [idParam],
      requestBody: { required: true, ...json(ref('ReturnInput')) },
      responses: { '200': res('OK', ref('BorrowingDetail')), '403': err('Bukan peminjam/admin/SPV'), '409': err('RETURN_CONFLICT / BORROWING_ALREADY_RETURNED'), '422': err('Validasi gagal') },
    },
  },
  '/equipment/{id}/report-damage': {
    post: {
      tags: ['Equipment'], summary: 'Lapor kerusakan dari halaman scan: status → damaged, notifikasi SPV/technician. 409 jika sedang dipinjam/sudah rusak/nonaktif', security: sec, parameters: [idParam],
      requestBody: { required: true, ...json({ type: 'object', required: ['notes'], properties: { notes: { type: 'string' }, condition: { type: 'string', enum: ['minor_damage', 'major_damage'], default: 'major_damage' } } }) },
      responses: { '200': res('OK', ref('Equipment')), '409': err('EQUIPMENT_BORROWED / ALREADY_DAMAGED / EQUIPMENT_INACTIVE') },
    },
  },
};

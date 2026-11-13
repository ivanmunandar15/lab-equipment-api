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
const paging = [q('page', { type: 'integer', default: 1 }), q('limit', { type: 'integer', default: 10, maximum: 100 }), q('order', { type: 'string', enum: ['asc', 'desc'] })];
const file = (description: string, mime: string) => ({ description, content: { [mime]: { schema: { type: 'string', format: 'binary' } } } });
const COND = ['good', 'minor_damage', 'major_damage'];
const T = 'Supporting Equipment';
const TX = 'Supporting Equipment Export/Import';

const filters = [
  q('status', { type: 'string', enum: ['available', 'borrowed', 'damaged'] }),
  q('condition', { type: 'string', enum: COND }),
  q('item_type', { type: 'string' }),
  q('is_active', { type: 'boolean' }),
  q('search', { type: 'string' }, 'nama atau item_code'),
];

export const supportingEquipmentTags = [{ name: T }, { name: TX }];

export const supportingEquipmentSchemas = {
  SupportingEquipment: {
    type: 'object',
    properties: {
      supporting_equipment_id: { type: 'string', format: 'uuid' },
      item_code: { type: 'string' },
      qr_token: { type: 'string', description: '12 karakter, dibuat server, tidak pernah berubah' },
      qr_url: { type: 'string', example: 'http://localhost:3001/scan/sp/Ab3dE5gH7jK9', description: 'QR mewakili JENIS ITEM' },
      item_name: { type: 'string' }, item_type: { type: 'string', nullable: true }, brand: { type: 'string', nullable: true }, model: { type: 'string', nullable: true },
      unit: { type: 'string', example: 'pcs' },
      total_quantity: { type: 'integer' }, available_quantity: { type: 'integer' }, borrowed_quantity: { type: 'integer', description: 'total − available' },
      condition: { type: 'string', enum: COND },
      status: { type: 'string', enum: ['available', 'borrowed', 'damaged'], description: 'Diturunkan: major_damage → damaged; available_quantity = 0 → borrowed; selain itu available' },
      description: { type: 'string', nullable: true }, specifications: { type: 'string', nullable: true },
      is_active: { type: 'boolean' },
      created_at: { type: 'string', format: 'date-time' }, updated_at: { type: 'string', format: 'date-time' },
    },
  },
  SupportingEquipmentDetail: {
    allOf: [
      ref('SupportingEquipment'),
      {
        type: 'object',
        properties: {
          active_borrowings: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                borrowing_id: { type: 'string' },
                user: { type: 'object', properties: { user_id: { type: 'string' }, name: { type: 'string' }, email: { type: 'string' } } },
                quantity_borrowed: { type: 'integer' }, quantity_returned: { type: 'integer' }, quantity_outstanding: { type: 'integer' },
                borrowing_time: { type: 'string', format: 'date-time' }, expected_return_time: { type: 'string', format: 'date-time' },
                purpose: { type: 'string' }, usage_location: { type: 'string', nullable: true }, is_overdue: { type: 'boolean' },
              },
            },
          },
        },
      },
    ],
  },
  SupportingEquipmentInput: {
    type: 'object',
    required: ['item_code', 'item_name', 'total_quantity'],
    description: 'qr_token, available_quantity, dan status pada body diabaikan.',
    properties: {
      item_code: { type: 'string' }, item_name: { type: 'string' }, item_type: { type: 'string' }, brand: { type: 'string' }, model: { type: 'string' },
      unit: { type: 'string', default: 'pcs' },
      total_quantity: { type: 'integer', minimum: 1, description: 'PATCH: available_quantity ikut berubah sebesar selisih; ditolak jika < jumlah yang sedang dipinjam' },
      condition: { type: 'string', enum: COND }, description: { type: 'string' }, specifications: { type: 'string' },
      is_active: { type: 'boolean', description: 'Hanya PATCH' },
    },
  },
};

export const supportingEquipmentPaths = {
  '/supporting-equipment': {
    get: {
      tags: [T], summary: 'Daftar supporting equipment', security: sec,
      parameters: [...paging, q('sort', { type: 'string', enum: ['item_name', 'item_code', 'item_type', 'status', 'condition', 'total_quantity', 'available_quantity', 'created_at', 'updated_at'] }), ...filters],
      responses: { '200': res('OK', { type: 'array', items: ref('SupportingEquipment') }, true) },
    },
    post: {
      tags: [T], summary: 'Buat item (admin, SPV); available_quantity = total_quantity; qr_token otomatis', security: sec,
      requestBody: { required: true, ...json(ref('SupportingEquipmentInput')) },
      responses: { '201': res('Dibuat', ref('SupportingEquipment')), '409': err('item_code ganda'), '422': err('Validasi gagal') },
    },
  },
  '/supporting-equipment/{id}': {
    get: { tags: [T], summary: 'Detail + daftar pinjaman aktif (siapa, berapa)', security: sec, parameters: [idParam], responses: { '200': res('OK', ref('SupportingEquipmentDetail')), '404': err('Tidak ditemukan') } },
    patch: {
      tags: [T], summary: 'Ubah item (admin, SPV)', security: sec, parameters: [idParam],
      requestBody: { required: true, ...json(ref('SupportingEquipmentInput')) },
      responses: { '200': res('OK', ref('SupportingEquipment')), '409': err('item_code ganda / QUANTITY_BELOW_BORROWED / ITEM_BORROWED (is_active=false)') },
    },
    delete: { tags: [T], summary: 'Soft delete; 409 ITEM_BORROWED jika masih ada yang dipinjam', security: sec, parameters: [idParam], responses: { '200': res('OK', ref('SupportingEquipment')), '409': err('ITEM_BORROWED') } },
  },
  '/supporting-equipment/{id}/qr.png': {
    get: { tags: [T], summary: 'Gambar QR PNG (jenis item)', security: sec, parameters: [idParam, q('size', { type: 'integer', minimum: 100, maximum: 1000, default: 300 })], responses: { '200': file('PNG', 'image/png') } },
  },
  '/supporting-equipment/export.csv': {
    get: { tags: [TX], summary: 'Ekspor CSV (UTF-8 + BOM, streaming); ikut filter list atau ?ids=', security: sec, parameters: [...filters, q('ids', { type: 'string' })], responses: { '200': file('CSV', 'text/csv') } },
  },
  '/supporting-equipment/export.zip': {
    get: { tags: [TX], summary: 'ZIP: supporting-equipment.csv + qr/{item_code}.png', security: sec, parameters: [...filters, q('ids', { type: 'string' })], responses: { '200': file('ZIP', 'application/zip') } },
  },
  '/supporting-equipment/labels.pdf': {
    get: {
      tags: [TX], summary: 'PDF label (QR + nama + kode)', security: sec,
      parameters: [q('ids', { type: 'string' }, 'UUID dipisah koma (wajib, maks 1000)'), q('layout', { type: 'string', enum: ['a4-3x8', 'sticker-50x30'], default: 'a4-3x8' })],
      responses: { '200': file('PDF', 'application/pdf'), '404': err('Sebagian id tidak ditemukan') },
    },
  },
  '/supporting-equipment/import-template.csv': { get: { tags: [TX], summary: 'Template CSV impor (admin, SPV)', security: sec, responses: { '200': file('CSV', 'text/csv') } } },
  '/supporting-equipment/import': {
    post: {
      tags: [TX], summary: 'Impor CSV (multipart `file`, maks 2 MB / 1000 baris). Default dry_run=true & all_or_nothing=true', security: sec,
      requestBody: {
        required: true,
        content: {
          'multipart/form-data': {
            schema: {
              type: 'object', required: ['file'],
              properties: { file: { type: 'string', format: 'binary' }, dry_run: { type: 'boolean', default: true }, all_or_nothing: { type: 'boolean', default: true } },
            },
          },
        },
      },
      responses: { '200': res('Hasil dry run'), '201': res('Tersimpan'), '413': err('File terlalu besar'), '422': err('IMPORT_VALIDATION_FAILED / INVALID_CSV / INVALID_CSV_HEADER') },
    },
  },
};

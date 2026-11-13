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
const paging = [q('page', { type: 'integer', default: 1 }), q('limit', { type: 'integer', default: 10, maximum: 100 }), q('sort', { type: 'string' }), q('order', { type: 'string', enum: ['asc', 'desc'] }), q('search', { type: 'string' })];
const E = { '401': err('Tidak terautentikasi'), '403': err('Role tidak diizinkan'), '404': err('Tidak ditemukan'), '422': err('Validasi gagal') };

export const monitoringDocumentsTags = [
  { name: 'Sensors', description: 'Kelola sensor & API key perangkat. admin, SPV' },
  { name: 'Monitoring', description: 'POST /readings untuk perangkat IoT (X-Sensor-Key); sisanya JWT' },
  { name: 'Documents', description: 'Dokumen alat (upload multipart, download, hapus)' },
  { name: 'Notifications', description: 'Notifikasi milik user login' },
];

export const monitoringDocumentsSchemas = {
  Sensor: {
    type: 'object',
    properties: {
      sensor_id: { type: 'string', format: 'uuid' },
      room_id: { type: 'string', format: 'uuid' },
      sensor_code: { type: 'string', example: 'TEMP-LAB1-01' },
      sensor_type: { type: 'string', enum: ['temperature', 'humidity'] },
      unit: { type: 'string', example: '°C' },
      sensor_location: { type: 'string', nullable: true },
      sensor_status: { type: 'string', enum: ['active', 'inactive', 'damaged'] },
      min_threshold: { type: 'number' },
      max_threshold: { type: 'number' },
      has_api_key: { type: 'boolean', description: 'Hash tidak pernah dikembalikan' },
      is_active: { type: 'boolean' },
      latest: { type: 'object', nullable: true, properties: { value: { type: 'number' }, measurement_time: { type: 'string', format: 'date-time' }, threshold_state: { type: 'string', enum: ['below_min', 'above_max', 'normal'] } } },
    },
  },
  SensorCreate: {
    type: 'object',
    required: ['room_id', 'sensor_code', 'sensor_type', 'min_threshold', 'max_threshold'],
    properties: {
      room_id: { type: 'string', format: 'uuid' },
      sensor_code: { type: 'string' },
      sensor_type: { type: 'string', enum: ['temperature', 'humidity'] },
      unit: { type: 'string', description: 'Default: °C / %' },
      sensor_location: { type: 'string', nullable: true },
      sensor_status: { type: 'string', enum: ['active', 'inactive', 'damaged'], default: 'active' },
      min_threshold: { type: 'number' },
      max_threshold: { type: 'number', description: 'Harus > min_threshold' },
      generate_api_key: { type: 'boolean', default: false, description: 'true → respons memuat api_key (sekali saja)' },
    },
  },
  SensorApiKey: {
    type: 'object',
    properties: { sensor_id: { type: 'string', format: 'uuid' }, sensor_code: { type: 'string' }, api_key: { type: 'string', example: 'lsk_...' }, rotated_at: { type: 'string', format: 'date-time' } },
  },
  IngestReading: {
    type: 'object',
    required: ['value'],
    properties: {
      sensor_code: { type: 'string', description: 'Opsional; jika ada harus sama dengan sensor milik key' },
      value: { type: 'number' },
      measurement_time: { type: 'string', format: 'date-time', description: 'Default: waktu server' },
    },
  },
  Document: {
    type: 'object',
    properties: {
      document_id: { type: 'string', format: 'uuid' },
      equipment_id: { type: 'string', format: 'uuid' },
      uploaded_by: { type: 'string', format: 'uuid' },
      document_type: { type: 'string', enum: ['manual', 'certificate', 'procedure', 'photo', 'other'] },
      file_name: { type: 'string' },
      file_type: { type: 'string', example: 'application/pdf' },
      file_size: { type: 'integer', description: 'byte' },
      uploaded_at: { type: 'string', format: 'date-time' },
      download_path: { type: 'string' },
    },
  },
  Notification: {
    type: 'object',
    properties: {
      notification_id: { type: 'string', format: 'uuid' },
      notification_type: { type: 'string', enum: ['borrowing', 'calibration', 'maintenance', 'monitoring', 'system'] },
      title: { type: 'string' },
      message: { type: 'string' },
      is_read: { type: 'boolean' },
      read_at: { type: 'string', format: 'date-time', nullable: true },
      created_at: { type: 'string', format: 'date-time' },
      borrowing_id: { type: 'string', format: 'uuid', nullable: true },
      calibration_id: { type: 'string', format: 'uuid', nullable: true },
      maintenance_id: { type: 'string', format: 'uuid', nullable: true },
    },
  },
};

export const monitoringDocumentsPaths = {
  '/sensors': {
    get: {
      tags: ['Sensors'], summary: 'Daftar sensor', security: sec,
      parameters: [...paging, q('room_id', { type: 'string', format: 'uuid' }), q('sensor_type', { type: 'string', enum: ['temperature', 'humidity'] }), q('sensor_status', { type: 'string', enum: ['active', 'inactive', 'damaged'] }), q('is_active', { type: 'boolean' })],
      responses: { '200': res('OK', { type: 'array', items: ref('Sensor') }, true), '401': E['401'], '403': E['403'] },
    },
    post: {
      tags: ['Sensors'], summary: 'Buat sensor (opsional sekaligus API key)', security: sec,
      requestBody: { required: true, ...json(ref('SensorCreate')) },
      responses: { '201': res('Dibuat; api_key hanya ada bila generate_api_key=true', ref('Sensor')), '409': err('sensor_code sudah dipakai / ruangan nonaktif'), '422': E['422'], '403': E['403'] },
    },
  },
  '/sensors/{id}': {
    get: { tags: ['Sensors'], summary: 'Detail sensor', security: sec, parameters: [idParam], responses: { '200': res('OK', ref('Sensor')), '404': E['404'] } },
    patch: { tags: ['Sensors'], summary: 'Ubah sensor', security: sec, parameters: [idParam], requestBody: { required: true, ...json({ type: 'object', description: 'Subset field SensorCreate + is_active' }) }, responses: { '200': res('OK', ref('Sensor')), '404': E['404'], '409': err('Konflik'), '422': E['422'] } },
    delete: { tags: ['Sensors'], summary: 'Nonaktifkan sensor (soft delete)', security: sec, parameters: [idParam], responses: { '200': res('OK', ref('Sensor')), '404': E['404'] } },
  },
  '/sensors/{id}/api-key': {
    post: { tags: ['Sensors'], summary: 'Buat / putar ulang API key (plaintext sekali saja)', security: sec, parameters: [idParam], responses: { '200': res('Key baru; key lama langsung tidak berlaku', ref('SensorApiKey')), '404': E['404'], '409': err('Sensor nonaktif') } },
    delete: { tags: ['Sensors'], summary: 'Cabut API key', security: sec, parameters: [idParam], responses: { '200': res('OK', ref('Sensor')), '404': E['404'] } },
  },
  '/monitoring/readings': {
    post: {
      tags: ['Monitoring'], summary: 'Kirim pembacaan (perangkat IoT)',
      description: 'Autentikasi header `X-Sensor-Key`. Body: satu objek, array, atau `{ readings: [...] }` (maks 500). Nilai di luar min/max → notifikasi (maks sekali per 30 menit per sensor).',
      security: [{ sensorKey: [] }],
      requestBody: { required: true, ...json({ oneOf: [ref('IngestReading'), { type: 'array', items: ref('IngestReading') }, { type: 'object', properties: { readings: { type: 'array', items: ref('IngestReading') } } }] }) },
      responses: {
        '201': res('Tersimpan', { type: 'object', properties: { sensor_code: { type: 'string' }, accepted: { type: 'integer' }, out_of_range: { type: 'integer' }, alert_sent: { type: 'boolean' }, received_at: { type: 'string', format: 'date-time' } } }),
        '401': err('Key tidak valid'), '403': err('sensor_code bukan milik key'), '409': err('Sensor tidak berstatus active'), '422': E['422'], '429': err('Rate limit'),
      },
    },
  },
  '/monitoring/sensors/{id}/readings': {
    get: {
      tags: ['Monitoring'], summary: 'Deret waktu untuk grafik', security: sec, parameters: [idParam, q('from', { type: 'string', format: 'date-time' }, 'Default: to − 24 jam'), q('to', { type: 'string', format: 'date-time' }, 'Default: sekarang'), q('interval', { type: 'string', enum: ['raw', '5m', '1h', '1d'], default: '5m' }, 'Agregat: avg/min/max/count. Maks 1000 titik (422 + suggested_interval bila lebih). raw: 1000 titik terbaru, `truncated` bila terpotong.')],
      responses: { '200': res('OK'), '404': E['404'], '422': E['422'] },
    },
  },
  '/monitoring/rooms/{id}/latest': {
    get: { tags: ['Monitoring'], summary: 'Pembacaan terbaru semua sensor ruangan', security: sec, parameters: [idParam], responses: { '200': res('Termasuk out_of_range, threshold_state, is_stale'), '404': E['404'] } },
  },
  '/monitoring/summary': {
    get: { tags: ['Monitoring'], summary: 'Ringkasan monitoring untuk dashboard', security: sec, responses: { '200': res('OK') } },
  },
  '/monitoring/stream': {
    get: {
      tags: ['Monitoring'], summary: 'SSE pembaruan realtime', security: sec,
      description: 'text/event-stream; event `ready`, `reading`, `reconnect` (server menutup tiap ±14 menit). Butuh header Authorization → pakai fetch-streaming, bukan EventSource.',
      parameters: [q('room_id', { type: 'string', format: 'uuid' }), q('sensor_id', { type: 'string', format: 'uuid' })],
      responses: { '200': { description: 'Stream', content: { 'text/event-stream': { schema: { type: 'string' } } } }, '429': err('Terlalu banyak koneksi') },
    },
  },
  '/documents': {
    get: { tags: ['Documents'], summary: 'Daftar dokumen', security: sec, parameters: [...paging, q('equipment_id', { type: 'string', format: 'uuid' }), q('document_type', { type: 'string', enum: ['manual', 'certificate', 'procedure', 'photo', 'other'] }), q('uploaded_by', { type: 'string', format: 'uuid' })], responses: { '200': res('OK', { type: 'array', items: ref('Document') }, true) } },
    post: {
      tags: ['Documents'], summary: 'Unggah dokumen (admin, SPV, technician)', security: sec,
      requestBody: { required: true, content: { 'multipart/form-data': { schema: { type: 'object', required: ['file', 'equipment_id', 'document_type'], properties: { file: { type: 'string', format: 'binary', description: 'PDF/JPEG/PNG/WebP/DOCX/XLSX, maks DOCUMENT_MAX_MB. photo = gambar saja' }, equipment_id: { type: 'string', format: 'uuid' }, document_type: { type: 'string', enum: ['manual', 'certificate', 'procedure', 'photo', 'other'] } } } } } },
      responses: { '201': res('Dibuat', ref('Document')), '404': E['404'], '413': err('File terlalu besar'), '422': E['422'] },
    },
  },
  '/documents/{id}': {
    get: { tags: ['Documents'], summary: 'Metadata dokumen', security: sec, parameters: [idParam], responses: { '200': res('OK', ref('Document')), '404': E['404'] } },
    delete: { tags: ['Documents'], summary: 'Hapus dokumen (admin/SPV atau pengunggah)', security: sec, parameters: [idParam], responses: { '200': res('OK'), '403': E['403'], '404': E['404'] } },
  },
  '/documents/{id}/download': {
    get: { tags: ['Documents'], summary: 'Unduh file', security: sec, parameters: [idParam, q('inline', { type: 'boolean' }, 'Hanya PDF/gambar yang bisa inline')], responses: { '200': { description: 'File', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } }, '404': E['404'] } },
  },
  '/notifications': {
    get: { tags: ['Notifications'], summary: 'Notifikasi milik user', security: sec, parameters: [...paging, q('is_read', { type: 'boolean' }), q('type', { type: 'string', enum: ['borrowing', 'calibration', 'maintenance', 'monitoring', 'system'] })], responses: { '200': res('OK', { type: 'array', items: ref('Notification') }, true) } },
  },
  '/notifications/unread-count': {
    get: { tags: ['Notifications'], summary: 'Jumlah belum dibaca', security: sec, responses: { '200': res('OK', { type: 'object', properties: { count: { type: 'integer' }, by_type: { type: 'object' } } }) } },
  },
  '/notifications/read-all': {
    patch: { tags: ['Notifications'], summary: 'Tandai semua dibaca (opsional body {type})', security: sec, responses: { '200': res('OK', { type: 'object', properties: { updated: { type: 'integer' } } }) } },
  },
  '/notifications/{id}/read': {
    patch: { tags: ['Notifications'], summary: 'Tandai satu notifikasi dibaca', security: sec, parameters: [idParam], responses: { '200': res('OK', ref('Notification')), '404': E['404'] } },
  },
};

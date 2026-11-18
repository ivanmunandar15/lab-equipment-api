const sec = [{ bearerAuth: [] }];
const ref = (n: string) => ({ $ref: `#/components/schemas/${n}` });
const json = (schema: unknown) => ({ content: { 'application/json': { schema } } });
const env = (data: unknown) => json({ type: 'object', properties: { success: { type: 'boolean', example: true }, data } });
const err = (description: string) => ({ description, ...json(ref('ErrorResponse')) });
const idParam = { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } };
const T = 'Email';

export const emailTags = [{ name: T, description: 'Pengingat kalibrasi lewat email (digest harian 07:00 bila CALIBRATION_EMAIL_MODE=auto). Penerima = penanggung jawab alat (aturan di /responsibilities) + PIC ruangan. Preferensi: semua role. Log: admin/SPV. Retry/uji/job manual/aturan: admin.' }];

export const emailSchemas = {
  EmailLog: {
    type: 'object',
    properties: {
      email_log_id: { type: 'string', format: 'uuid' }, user_id: { type: 'string', format: 'uuid' },
      equipment_id: { type: 'string', format: 'uuid', nullable: true }, parent_id: { type: 'string', format: 'uuid', nullable: true },
      reminder_type: { type: 'string', enum: ['calibration_30d', 'calibration_7d', 'calibration_1d', 'calibration_overdue', 'borrowing_overdue', 'digest'] },
      next_calibration_date: { type: 'string', format: 'date', nullable: true }, recipient_email: { type: 'string' }, subject: { type: 'string' },
      status: { type: 'string', enum: ['queued', 'sent', 'failed'] }, attempts: { type: 'integer' }, error_message: { type: 'string', nullable: true },
      provider_message_id: { type: 'string', nullable: true }, created_at: { type: 'string', format: 'date-time' }, sent_at: { type: 'string', format: 'date-time', nullable: true },
    },
  },
};

const q = (name: string, schema: unknown) => ({ name, in: 'query', schema });

export const emailPaths = {
  '/responsibilities': {
    get: {
      tags: [T], summary: 'Aturan penanggung jawab alat + cakupan (admin, SPV)', security: sec,
      description: 'rules[]: user + code_prefix (awalan kode inventaris) dan/atau room, beserta equipment_count (alat aktif yang cocok). coverage: dari alat berjadwal kalibrasi, berapa yang punya penerima (aturan atau PIC ruangan) dan contoh yang belum (tidak akan menerima email).',
      responses: { '200': { description: 'OK', ...env({ type: 'object', properties: { rules: { type: 'array', items: { type: 'object' } }, coverage: { type: 'object' } } }) }, '403': err('Tidak punya akses') },
    },
    post: {
      tags: [T], summary: 'Tambah aturan penanggung jawab (admin)', security: sec,
      description: 'Minimal code_prefix atau room_id. Alat cocok bila semua kriteria yang terisi cocok; awalan cocok pada batas kode ("INV L-ACT 10" cocok "INV L-ACT 10-01", bukan "INV L-ACT 100-1"), tanpa membedakan huruf besar/kecil dan spasi berulang.',
      requestBody: { required: true, ...json({ type: 'object', required: ['user_id'], properties: { user_id: { type: 'string', format: 'uuid' }, code_prefix: { type: 'string', nullable: true, maxLength: 50 }, room_id: { type: 'string', format: 'uuid', nullable: true } } }) },
      responses: { '201': { description: 'Dibuat (termasuk equipment_count)' }, '403': err('Tidak punya akses'), '409': err('Aturan yang sama sudah ada'), '422': err('Validasi gagal') },
    },
  },
  '/responsibilities/{id}': {
    delete: {
      tags: [T], summary: 'Hapus aturan penanggung jawab (admin)', security: sec, parameters: [idParam],
      responses: { '200': { description: 'Dihapus' }, '403': err('Tidak punya akses'), '404': err('Tidak ditemukan') },
    },
  },
  '/me/email-preferences': {
    patch: {
      tags: [T], summary: 'Aktif/nonaktifkan email pengingat milik sendiri', security: sec,
      requestBody: { required: true, ...json({ type: 'object', required: ['email_notifications'], properties: { email_notifications: { type: 'boolean' } } }) },
      responses: { '200': { description: 'OK', ...env({ type: 'object', properties: { user_id: { type: 'string' }, email_notifications: { type: 'boolean' } } }) }, '422': err('Validasi gagal') },
    },
  },
  '/email-logs': {
    get: {
      tags: [T], summary: 'Daftar log email (admin, SPV)', security: sec,
      parameters: [q('page', { type: 'integer' }), q('limit', { type: 'integer', maximum: 100 }), q('sort', { type: 'string', enum: ['created_at', 'sent_at', 'status', 'attempts', 'recipient_email'] }), q('order', { type: 'string', enum: ['asc', 'desc'] }), q('search', { type: 'string' }), q('status', { type: 'string', enum: ['queued', 'sent', 'failed'] }), q('reminder_type', { type: 'string' }), q('user_id', { type: 'string', format: 'uuid' }), q('date_from', { type: 'string' }), q('date_to', { type: 'string' }), q('include_markers', { type: 'boolean', description: 'Sertakan penanda per-alat (default false)' })],
      responses: { '200': { description: 'OK', ...env({ type: 'array', items: ref('EmailLog') }) }, '403': err('Tidak punya akses') },
    },
  },
  '/email-logs/{id}/retry': {
    post: {
      tags: [T], summary: 'Kirim ulang email gagal (admin)', security: sec, parameters: [idParam],
      responses: { '200': { description: 'Masuk antrean' }, '404': err('Tidak ditemukan'), '409': err('Status bukan failed') },
    },
  },
  '/admin/email/test': {
    post: {
      tags: [T], summary: 'Kirim email uji ke alamat user yang login (admin)', security: sec,
      responses: { '200': { description: 'Hasil pengiriman (status sent/failed + error_message)' }, '403': err('Tidak punya akses') },
    },
  },
  '/admin/email/calibration-reminders/send': {
    post: {
      tags: [T], summary: 'Kirim email pengingat kalibrasi HANYA ke penerima terpilih (admin)', security: sec,
      description: 'Rencana dihitung ulang saat ini lalu difilter ke user_ids; penerima yang tidak dipilih tidak disentuh (tanpa penanda). Email diantrekan: status akhir (sent/failed) ada di GET /email-logs. Pratinjau: POST /admin/jobs/calibration-reminders/run?dry_run=true.',
      requestBody: { required: true, ...json({ type: 'object', required: ['user_ids'], properties: { user_ids: { type: 'array', minItems: 1, maxItems: 200, items: { type: 'string', format: 'uuid' } } } }) },
      responses: {
        '200': { description: 'Hasil: recipients, queued, skipped, failed, requested, not_planned, email_enabled', ...env({ type: 'object' }) },
        '403': err('Tidak punya akses'), '422': err('Validasi gagal'),
      },
    },
  },
  '/admin/jobs/calibration-reminders/run': {
    post: {
      tags: [T], summary: 'Jalankan job pengingat kalibrasi manual (admin)', description: 'dry_run=true: kembalikan daftar email yang AKAN dikirim (to, user_id, name, role, subject, items), daftar unassigned (alat jatuh tempo tanpa penerima: tidak akan dikirim ke siapa pun), beserta mode (CALIBRATION_EMAIL_MODE) dan email_enabled, tanpa mengirim atau mencatat apa pun. dry_run=false menjalankan job lengkap (di mode manual, bagian email dilewati).', security: sec,
      parameters: [q('dry_run', { type: 'boolean', default: false })],
      responses: { '200': { description: 'OK' }, '403': err('Tidak punya akses') },
    },
  },
};

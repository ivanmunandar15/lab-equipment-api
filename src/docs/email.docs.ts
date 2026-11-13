const sec = [{ bearerAuth: [] }];
const ref = (n: string) => ({ $ref: `#/components/schemas/${n}` });
const json = (schema: unknown) => ({ content: { 'application/json': { schema } } });
const env = (data: unknown) => json({ type: 'object', properties: { success: { type: 'boolean', example: true }, data } });
const err = (description: string) => ({ description, ...json(ref('ErrorResponse')) });
const idParam = { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } };
const T = 'Email';

export const emailTags = [{ name: T, description: 'Pengingat kalibrasi lewat email (digest harian 07:00). Preferensi: semua role. Log: admin/SPV. Retry/uji/job manual: admin.' }];

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
  '/admin/jobs/calibration-reminders/run': {
    post: {
      tags: [T], summary: 'Jalankan job pengingat kalibrasi manual (admin)', description: 'dry_run=true: kembalikan daftar email yang AKAN dikirim tanpa mengirim atau mencatat apa pun.', security: sec,
      parameters: [q('dry_run', { type: 'boolean', default: false })],
      responses: { '200': { description: 'OK' }, '403': err('Tidak punya akses') },
    },
  },
};

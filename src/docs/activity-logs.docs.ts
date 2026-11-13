const sec = [{ bearerAuth: [] }];
const ref = (n: string) => ({ $ref: `#/components/schemas/${n}` });
const json = (schema: unknown) => ({ content: { 'application/json': { schema } } });
const res = (description: string, data?: unknown, meta = false) => ({
  description,
  ...(data
    ? json({
        type: 'object',
        properties: {
          success: { type: 'boolean', example: true },
          data,
          ...(meta ? { meta: ref('PageMeta') } : {}),
        },
      })
    : {}),
});
const err = (description: string) => ({ description, ...json(ref('ErrorResponse')) });
const q = (name: string, schema: unknown, description?: string) => ({ name, in: 'query', schema, ...(description ? { description } : {}) });

export const activityLogsTags = [{ name: 'Activity Logs', description: 'Read-only. admin, SPV, QA' }];

export const activityLogsSchemas = {
  ActivityLog: {
    type: 'object',
    properties: {
      log_id: { type: 'string', format: 'uuid' },
      user_id: { type: 'string', format: 'uuid', nullable: true },
      action: { type: 'string', example: 'UPDATE', description: 'CREATE, UPDATE, DELETE, LOGIN, BORROW, RETURN, CALIBRATE, MAINTENANCE_START, MAINTENANCE_COMPLETE, EXPORT, ...' },
      entity_type: { type: 'string', example: 'user' },
      entity_id: { type: 'string', nullable: true },
      ip_address: { type: 'string', nullable: true },
      created_at: { type: 'string', format: 'date-time' },
      user: {
        type: 'object',
        nullable: true,
        properties: {
          user_id: { type: 'string', format: 'uuid' },
          name: { type: 'string' },
          email: { type: 'string' },
          role: { type: 'string', enum: ['QA', 'admin', 'technician', 'SPV'] },
        },
      },
    },
  },
  ActivityLogDetail: {
    allOf: [
      ref('ActivityLog'),
      {
        type: 'object',
        properties: {
          old_data: { type: 'object', nullable: true },
          new_data: { type: 'object', nullable: true },
          diff: {
            type: 'array',
            description: 'Field yang berubah antara old_data dan new_data',
            items: { type: 'object', properties: { field: { type: 'string' }, old: {}, new: {} } },
          },
        },
      },
    ],
  },
};

export const activityLogsPaths = {
  '/activity-logs': {
    get: {
      tags: ['Activity Logs'],
      summary: 'Daftar activity log',
      security: sec,
      parameters: [
        q('page', { type: 'integer', default: 1 }),
        q('limit', { type: 'integer', default: 10, maximum: 100 }),
        q('sort', { type: 'string', enum: ['created_at', 'action', 'entity_type'] }),
        q('order', { type: 'string', enum: ['asc', 'desc'] }),
        q('search', { type: 'string' }, 'Cari di action, entity_type, entity_id, nama/email user'),
        q('user_id', { type: 'string', format: 'uuid' }),
        q('action', { type: 'string' }, 'Tidak peka huruf besar/kecil, mis. borrow'),
        q('entity_type', { type: 'string' }, 'mis. user, equipment, borrowing'),
        q('entity_id', { type: 'string' }),
        q('date_from', { type: 'string' }, 'ISO 8601, mis. 2026-10-01 atau 2026-10-01T00:00:00Z'),
        q('date_to', { type: 'string' }, 'ISO 8601; format YYYY-MM-DD berlaku sampai akhir hari (UTC)'),
      ],
      responses: {
        '200': res('OK', { type: 'array', items: ref('ActivityLog') }, true),
        '403': err('Role tidak diizinkan'),
        '422': err('Filter tidak valid'),
      },
    },
  },
  '/activity-logs/{id}': {
    get: {
      tags: ['Activity Logs'],
      summary: 'Detail activity log beserta diff old_data vs new_data',
      security: sec,
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      responses: { '200': res('OK', ref('ActivityLogDetail')), '404': err('Tidak ditemukan') },
    },
  },
};

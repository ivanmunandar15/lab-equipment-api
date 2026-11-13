const sec = [{ bearerAuth: [] }];
const ref = (n: string) => ({ $ref: `#/components/schemas/${n}` });
const json = (schema: unknown, example?: unknown) => ({ content: { 'application/json': { schema, ...(example ? { example } : {}) } } });
const envelope = (data: unknown, example: unknown) =>
  json({ type: 'object', properties: { success: { type: 'boolean', example: true }, data } }, { success: true, data: example });
const err = (description: string) => ({ description, ...json(ref('ErrorResponse')) });
const T = 'Dashboard';

const STATUS_COUNTS = {
  type: 'object',
  properties: Object.fromEntries(['available', 'borrowed', 'damaged', 'maintenance', 'calibration'].map((s) => [s, { type: 'integer' }])),
};

export const dashboardTags = [{ name: T, description: 'Semua role login. Hasil di-cache singkat (DASHBOARD_CACHE_SECONDS, default 30 detik). recent-activity: admin, SPV, QA.' }];

export const dashboardSchemas = {
  DashboardStats: {
    type: 'object',
    properties: {
      equipment: { type: 'object', properties: { total: { type: 'integer' }, by_status: STATUS_COUNTS } },
      borrowings: { type: 'object', properties: { active: { type: 'integer' }, overdue: { type: 'integer' } } },
      costs_this_month: {
        type: 'object',
        properties: { month: { type: 'string', example: '2026-10' }, maintenance: { type: 'number' }, calibration: { type: 'number' }, total: { type: 'number' } },
      },
      generated_at: { type: 'string', format: 'date-time' },
    },
  },
  DashboardCharts: {
    type: 'object',
    properties: {
      equipment_status_distribution: { type: 'array', items: { type: 'object', properties: { status: { type: 'string' }, count: { type: 'integer' } } } },
      borrowing_trend: { type: 'array', description: '12 bulan terakhir, lama → baru', items: { type: 'object', properties: { month: { type: 'string', example: '2026-10' }, count: { type: 'integer' } } } },
      cost_per_month: {
        type: 'array',
        items: { type: 'object', properties: { month: { type: 'string' }, maintenance: { type: 'number' }, calibration: { type: 'number' }, total: { type: 'number' } } },
      },
    },
  },
  DashboardAlerts: {
    type: 'object',
    properties: {
      calibration: { type: 'object', description: 'Alat aktif dengan kalibrasi jatuh tempo <= 30 hari atau sudah terlambat' },
      overdue_borrowings: { type: 'object' },
      sensors_out_of_range: { type: 'object', description: 'Pembacaan terbaru (<= 24 jam) di luar min/max threshold' },
      low_stock: { type: 'object', description: 'available_quantity <= LOW_STOCK_THRESHOLD' },
    },
  },
};

export const dashboardPaths = {
  '/dashboard/stats': {
    get: {
      tags: [T], summary: 'Ringkasan: total alat, per status, peminjaman aktif/terlambat, biaya bulan ini', security: sec,
      responses: {
        '200': {
          description: 'OK',
          ...envelope(ref('DashboardStats'), {
            equipment: { total: 30, by_status: { available: 18, borrowed: 5, damaged: 2, maintenance: 3, calibration: 2 } },
            borrowings: { active: 5, overdue: 3 },
            costs_this_month: { month: '2026-10', maintenance: 1500000, calibration: 2750000, total: 4250000 },
            generated_at: '2026-10-31T08:00:00.000Z',
          }),
        },
        '401': err('Belum login / token kedaluwarsa'),
      },
    },
  },
  '/dashboard/charts': {
    get: {
      tags: [T], summary: 'Distribusi status, tren peminjaman 12 bulan, biaya maintenance + kalibrasi per bulan', security: sec,
      responses: {
        '200': {
          description: 'OK',
          ...envelope(ref('DashboardCharts'), {
            equipment_status_distribution: [{ status: 'available', count: 18 }, { status: 'borrowed', count: 5 }],
            borrowing_trend: [{ month: '2025-11', count: 4 }, { month: '2026-10', count: 9 }],
            cost_per_month: [{ month: '2026-10', maintenance: 1500000, calibration: 2750000, total: 4250000 }],
          }),
        },
        '401': err('Belum login / token kedaluwarsa'),
      },
    },
  },
  '/dashboard/alerts': {
    get: {
      tags: [T], summary: 'Kalibrasi jatuh tempo/terlambat, peminjaman terlambat, sensor di luar batas, stok rendah', security: sec,
      parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', default: 20, minimum: 1, maximum: 100 }, description: 'Maks item per kategori (total tetap penuh)' }],
      responses: {
        '200': {
          description: 'OK',
          ...envelope(ref('DashboardAlerts'), {
            calibration: {
              total: 2, overdue: 1, threshold_days: 30,
              items: [{ equipment_id: '0b9f…', inventory_code: 'EQ-001', equipment_name: 'Oven', status: 'available', next_calibration_date: '2026-10-20', calibration_state: 'overdue', days_remaining: -11 }],
            },
            overdue_borrowings: {
              total: 1,
              items: [{ borrowing_id: '7c1e…', borrower: { user_id: 'a1b2…', name: 'Teknisi' }, purpose: 'Praktikum kimia', expected_return_time: '2026-10-30T08:00:00.000Z', hours_overdue: 24 }],
            },
            sensors_out_of_range: {
              total: 1,
              items: [{ sensor_id: 'c3d4…', sensor_code: 'SNS-T-01', sensor_type: 'temperature', room: { room_id: 'e5f6…', room_name: 'Lab A' }, unit: '°C', value: 31.5, min_threshold: 18, max_threshold: 28, direction: 'above_max', measurement_time: '2026-10-31T07:55:00.000Z' }],
            },
            low_stock: { total: 1, threshold: 2, items: [{ supporting_equipment_id: '9a8b…', item_code: 'SP-010', item_name: 'Sarung tangan', unit: 'box', total_quantity: 20, available_quantity: 1 }] },
          }),
        },
        '401': err('Belum login / token kedaluwarsa'),
        '422': err('Validasi query gagal'),
      },
    },
  },
  '/dashboard/recent-activity': {
    get: {
      tags: [T], summary: '10 aktivitas terakhir (admin, SPV, QA)', security: sec,
      responses: {
        '200': {
          description: 'OK',
          ...envelope({ type: 'array', items: ref('ActivityLog') }, [
            { log_id: 'f0e1…', user_id: 'a1b2…', action: 'RETURN', entity_type: 'borrowing', entity_id: '7c1e…', ip_address: '::1', created_at: '2026-10-31T07:30:00.000Z', user: { user_id: 'a1b2…', name: 'Teknisi', email: 'technician@lab.local', role: 'technician' } },
          ]),
        },
        '401': err('Belum login / token kedaluwarsa'),
        '403': err('Role tidak berhak (technician)'),
      },
    },
  },
};

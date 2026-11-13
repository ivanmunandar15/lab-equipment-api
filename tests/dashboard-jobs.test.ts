/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

vi.mock('../src/config/db', async () => {
  const { createFakeDb } = await import('./helpers/fake-db');
  const fake = createFakeDb();
  return { getDb: () => fake, disconnectDb: async () => undefined, __fake: fake };
});

import * as dbModule from '../src/config/db';
import { createApp } from '../src/app';
import { runCalibrationReminders, calibrationStage } from '../src/jobs/calibration.job';
import { runBorrowingOverdueReminders } from '../src/jobs/borrowing-overdue.job';
import { runLowStockReminders } from '../src/jobs/low-stock.job';
import { runWeeklyCleanup } from '../src/jobs/weekly-cleanup.job';
import { JOBS } from '../src/jobs';
import { last12Months } from '../src/modules/dashboard/dashboard.service';
import { DEMO_PASSWORD, ROOM_B } from './helpers/fake-db';

const fake = (dbModule as any).__fake;
const app = createApp();
const API = '/api/v1';
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const login = async (email: string, password = DEMO_PASSWORD) =>
  (await request(app).post(`${API}/auth/login`).send({ email, password })).body.data.access_token as string;

let admin: string, tech: string, spv: string;
let seq = 0;
const mkEq = async (over: Record<string, unknown> = {}) => {
  seq++;
  return (await request(app).post(`${API}/equipment`).set(bearer(spv)).send({ inventory_code: `D-${seq}`, equipment_name: `Alat ${seq}`, equipment_type: 'Oven', room_id: ROOM_B, ...over })).body.data;
};

beforeEach(async () => {
  await fake.reset();
  admin = await login('admin@lab.local');
  tech = await login('technician@lab.local');
  await request(app).post(`${API}/users`).set(bearer(admin)).send({ name: 'SPV', email: 'spv@x.local', role: 'SPV', password: 'Password123' });
  await request(app).post(`${API}/users`).set(bearer(admin)).send({ name: 'QA', email: 'qa@x.local', role: 'QA', password: 'Password123' });
  spv = await login('spv@x.local', 'Password123');
});

describe('GET /dashboard', () => {
  it('stats: total, per status, peminjaman aktif/terlambat, biaya bulan ini', async () => {
    const e1 = await mkEq();
    await mkEq();
    const techId = fake.user.rows.find((u: any) => u.email === 'technician@lab.local').user_id;
    const now = new Date();
    fake.borrowing.rows.push({ borrowing_id: 'b1', user_id: techId, borrowing_time: new Date(now.getTime() - 5 * 86_400_000), expected_return_time: new Date(now.getTime() - 86_400_000), borrowing_status: 'borrowed', purpose: 'x' });
    fake.borrowing.rows.push({ borrowing_id: 'b2', user_id: techId, borrowing_time: now, expected_return_time: new Date(now.getTime() + 86_400_000), borrowing_status: 'borrowed', purpose: 'y' });
    fake.equipment.rows.find((r: any) => r.equipment_id === e1.equipment_id).status = 'borrowed';
    fake.maintenance.rows.push({ maintenance_id: 'm1', status: 'completed', cost: 1_000_000, completion_date: now, maintenance_date: now });
    fake.maintenance.rows.push({ maintenance_id: 'm2', status: 'scheduled', cost: 999, completion_date: null, maintenance_date: now });
    fake.calibration.rows.push({ calibration_id: 'c1', equipment_id: e1.equipment_id, calibration_date: new Date(day(0)), cost: 500_000 });

    const res = await request(app).get(`${API}/dashboard/stats`).set(bearer(tech));
    expect(res.status).toBe(200);
    expect(res.body.data.equipment).toMatchObject({ total: 2, by_status: { available: 1, borrowed: 1, damaged: 0, maintenance: 0, calibration: 0 } });
    expect(res.body.data.borrowings).toEqual({ active: 2, overdue: 1 });
    expect(res.body.data.costs_this_month).toMatchObject({ maintenance: 1_000_000, calibration: 500_000, total: 1_500_000 });
  });

  it('charts: 12 bulan berurutan, tren peminjaman & biaya per bulan', async () => {
    const now = new Date();
    fake.borrowing.rows.push({ borrowing_id: 'b1', user_id: 'u', borrowing_time: now, expected_return_time: now, borrowing_status: 'returned', purpose: 'x' });
    fake.borrowing.rows.push({ borrowing_id: 'b2', user_id: 'u', borrowing_time: now, expected_return_time: now, borrowing_status: 'returned', purpose: 'x' });
    fake.maintenance.rows.push({ maintenance_id: 'm1', status: 'completed', cost: 250, completion_date: now });
    const res = await request(app).get(`${API}/dashboard/charts`).set(bearer(tech));
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.borrowing_trend.map((x: any) => x.month)).toEqual(last12Months());
    expect(d.borrowing_trend).toHaveLength(12);
    expect(d.borrowing_trend[11].count).toBe(2);
    expect(d.cost_per_month[11]).toMatchObject({ maintenance: 250, calibration: 0, total: 250 });
    expect(d.equipment_status_distribution.map((x: any) => x.status)).toEqual(['available', 'borrowed', 'damaged', 'maintenance', 'calibration']);
  });

  it('alerts: kalibrasi <=30 hari & terlambat, peminjaman terlambat, stok rendah', async () => {
    await mkEq({ next_calibration_date: day(-3) });
    await mkEq({ next_calibration_date: day(10) });
    await mkEq({ next_calibration_date: day(90) });
    fake.borrowing.rows.push({ borrowing_id: 'b1', user_id: 'u', borrowing_time: new Date(), expected_return_time: new Date(Date.now() - 3_600_000), borrowing_status: 'borrowed', purpose: 'x' });
    await request(app).post(`${API}/supporting-equipment`).set(bearer(spv)).send({ item_code: 'SP-LOW', item_name: 'Tip', total_quantity: 10 });
    fake.supportingEquipment.rows.find((r: any) => r.item_code === 'SP-LOW').available_quantity = 1;
    await request(app).post(`${API}/supporting-equipment`).set(bearer(spv)).send({ item_code: 'SP-OK', item_name: 'Gelas', total_quantity: 10 });

    const res = await request(app).get(`${API}/dashboard/alerts`).set(bearer(tech));
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.calibration).toMatchObject({ total: 2, overdue: 1, threshold_days: 30 });
    expect(d.calibration.items.map((i: any) => i.calibration_state)).toEqual(['overdue', 'due_soon']);
    expect(d.overdue_borrowings.total).toBe(1);
    expect(d.sensors_out_of_range).toEqual({ total: 0, items: [] });
    expect(d.low_stock.total).toBe(1);
    expect(d.low_stock.items[0].item_code).toBe('SP-LOW');
    expect((await request(app).get(`${API}/dashboard/alerts?limit=0`).set(bearer(tech))).status).toBe(422);
  });

  it('recent-activity: maks 10, technician 403, tanpa token 401', async () => {
    for (let i = 0; i < 12; i++) fake.activityLog.rows.push({ log_id: `l${i}`, user_id: null, action: 'CREATE', entity_type: 'room', entity_id: String(i), created_at: new Date(Date.now() + i) });
    const res = await request(app).get(`${API}/dashboard/recent-activity`).set(bearer(spv));
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(10);
    expect((await request(app).get(`${API}/dashboard/recent-activity`).set(bearer(tech))).status).toBe(403);
    expect((await request(app).get(`${API}/dashboard/recent-activity`)).status).toBe(401);
  });
});

describe('Cron jobs', () => {
  it('jadwal terdaftar', () => {
    expect(JOBS.map((j) => j.name)).toEqual(['calibration-reminders', 'borrowing-overdue', 'low-stock', 'weekly-cleanup']);
    expect(JOBS.find((j) => j.name === 'calibration-reminders')?.schedule).toBe('0 7 * * *');
  });

  it('tahap kalibrasi: H30 / H7 / OVERDUE', () => {
    expect([calibrationStage(30), calibrationStage(8), calibrationStage(7), calibrationStage(0), calibrationStage(-1)]).toEqual(['H30', 'H30', 'H7', 'H7', 'OVERDUE']);
  });

  it('kalibrasi: notifikasi per alat per tahap, tanpa duplikat saat dijalankan ulang; pindah tahap → notifikasi baru', async () => {
    const e = await mkEq({ next_calibration_date: day(25) });
    await mkEq({ next_calibration_date: day(200) });
    const r1 = await runCalibrationReminders();
    expect(r1).toMatchObject({ checked: 1, created: 1 });
    const n1 = fake.notification.rows.length;
    expect(n1).toBeGreaterThan(0);
    expect(fake.notification.rows.every((n: any) => n.notification_type === 'calibration')).toBe(true);
    const roles = new Set(fake.notification.rows.map((n: any) => fake.user.rows.find((u: any) => u.user_id === n.user_id).role));
    expect(roles.has('QA')).toBe(false);

    const r2 = await runCalibrationReminders();
    expect(r2).toMatchObject({ created: 0, skipped: 1 });
    expect(fake.notification.rows.length).toBe(n1);

    // 20 hari kemudian: sisa 5 hari → tahap H7 → notifikasi baru
    await runCalibrationReminders(new Date(Date.now() + 20 * 86_400_000));
    expect(fake.notification.rows.length).toBe(n1 * 2);
    // 30 hari kemudian: terlambat → tahap OVERDUE
    await runCalibrationReminders(new Date(Date.now() + 30 * 86_400_000));
    expect(fake.notification.rows.length).toBe(n1 * 3);
    expect(fake.notification.rows.some((n: any) => n.title === 'Kalibrasi terlambat')).toBe(true);
    expect(e.equipment_id).toBeTruthy();
  });

  it('peminjaman terlambat: ke peminjam + SPV, maksimal sekali per hari', async () => {
    const techId = fake.user.rows.find((u: any) => u.email === 'technician@lab.local').user_id;
    const spvId = fake.user.rows.find((u: any) => u.email === 'spv@x.local').user_id;
    fake.borrowing.rows.push({ borrowing_id: 'b1', user_id: techId, borrowing_time: new Date(Date.now() - 5 * 3_600_000), expected_return_time: new Date(Date.now() - 2 * 3_600_000), borrowing_status: 'borrowed', purpose: 'Praktikum' });
    fake.borrowing.rows.push({ borrowing_id: 'b2', user_id: techId, borrowing_time: new Date(), expected_return_time: new Date(Date.now() + 3_600_000), borrowing_status: 'borrowed', purpose: 'Belum telat' });
    const r1 = await runBorrowingOverdueReminders();
    expect(r1).toMatchObject({ overdue: 1, notified: 1 });
    expect(fake.notification.rows.map((n: any) => n.user_id).sort()).toEqual([spvId, techId].sort());
    expect(fake.notification.rows.every((n: any) => n.borrowing_id === 'b1' && n.notification_type === 'borrowing')).toBe(true);

    await runBorrowingOverdueReminders(); // jam berikutnya, hari sama
    expect(fake.notification.rows).toHaveLength(2);
    await runBorrowingOverdueReminders(new Date(Date.now() + 2 * 86_400_000)); // hari berikutnya
    expect(fake.notification.rows).toHaveLength(4);
  });

  it('stok rendah: satu notifikasi per item per hari ke admin & SPV', async () => {
    await request(app).post(`${API}/supporting-equipment`).set(bearer(spv)).send({ item_code: 'SP-LOW', item_name: 'Tip', total_quantity: 5 });
    fake.supportingEquipment.rows[0].available_quantity = 0;
    expect(await runLowStockReminders()).toMatchObject({ low_stock_items: 1, notified: 1 });
    const roles = fake.notification.rows.map((n: any) => fake.user.rows.find((u: any) => u.user_id === n.user_id).role).sort();
    expect(roles).toEqual(['SPV', 'admin']);
    expect(await runLowStockReminders()).toMatchObject({ notified: 0 });
    expect(fake.notification.rows).toHaveLength(2);
  });

  it('mingguan: hapus refresh token kedaluwarsa saja (yang masih berlaku tetap)', async () => {
    const before = fake.refreshToken.rows.length; // dari login di beforeEach
    expect(before).toBeGreaterThan(0);
    fake.refreshToken.rows.push({ token_id: 'old', user_id: 'u', token_hash: 'h-old', expires_at: new Date(Date.now() - 1000) });
    const r: any = await runWeeklyCleanup();
    expect(r.expired_refresh_tokens_deleted).toBe(1);
    expect(fake.refreshToken.rows).toHaveLength(before);
  });
});

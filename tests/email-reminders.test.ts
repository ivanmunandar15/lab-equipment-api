/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'crypto';

// ───────── fake DB minimal khusus modul email ─────────
const state: { equipment: any[]; users: any[]; logs: any[] } = { equipment: [], users: [], logs: [] };
const fakeDb: any = {
  equipment: { findMany: async () => state.equipment },
  user: { findMany: async ({ where }: any) => state.users.filter((u) => u.is_active && where.role.in.includes(u.role) && (where.email_notifications === undefined || u.email_notifications === where.email_notifications)) },
  emailLog: {
    async findMany({ where }: any = {}) {
      return state.logs.filter((l) => (!where?.equipment_id?.in || where.equipment_id.in.includes(l.equipment_id)) && (where?.status === undefined || l.status === where.status) && (where?.parent_id === undefined || l.parent_id === where.parent_id));
    },
    async findUnique({ where }: any) {
      const l = state.logs.find((x) => x.email_log_id === where.email_log_id);
      return l ? { ...l, user: { name: 'Budi' } } : null;
    },
    async create({ data }: any) {
      dupCheck(data);
      const row = { email_log_id: randomUUID(), equipment_id: null, parent_id: null, next_calibration_date: null, attempts: 0, error_message: null, sent_at: null, created_at: new Date(), ...data };
      state.logs.push(row);
      return row;
    },
    async createMany({ data }: any) {
      data.forEach(dupCheck);
      data.forEach((d: any) => state.logs.push({ email_log_id: randomUUID(), attempts: 0, error_message: null, sent_at: null, created_at: new Date(), ...d }));
    },
    async update({ where, data }: any) {
      const l = state.logs.find((x) => x.email_log_id === where.email_log_id);
      Object.assign(l, data);
      return l;
    },
    async updateMany({ where, data }: any) {
      state.logs.filter((l) => (where.parent_id !== undefined ? l.parent_id === where.parent_id : where.email_log_id.in.includes(l.email_log_id))).forEach((l) => Object.assign(l, data));
    },
  },
  $transaction: async (fn: any) => fn(fakeDb),
};
function dupCheck(d: any) {
  const k = (x: any) => [x.user_id, x.equipment_id ?? null, x.reminder_type, x.next_calibration_date ? +x.next_calibration_date : null].join('|');
  if (d.equipment_id && state.logs.some((l) => k(l) === k(d))) throw Object.assign(new Error('unique'), { code: 'P2002' });
}

vi.mock('../src/config/db', () => ({ getDb: () => fakeDb, disconnectDb: async () => {} }));
const sendMail = vi.fn(async () => 'msg-1');
vi.mock('../src/modules/email/mailer', () => ({ sendMail: (...a: any[]) => (sendMail as any)(...a), verifyMailer: async () => true }));

import { emailStageFor, daysUntil } from '../src/modules/email/reminder-stage';
import { planCalibrationEmails, recipientsForEquipment, runCalibrationEmailReminders } from '../src/modules/email/calibration-reminders';
import { deliverEmail } from '../src/modules/email/email.service';
import { emailQueue } from '../src/modules/email/email.queue';
import { renderDigest } from '../src/modules/email/templates/digest';

const NOW = new Date('2026-11-02T00:30:00.000Z'); // 07:30 WIB
const TODAY = new Date('2026-11-02T00:00:00.000Z');
const day = (n: number) => new Date(TODAY.getTime() + n * 86_400_000);

const mkUser = (o: any = {}) => ({ user_id: randomUUID(), name: 'U', email: `${randomUUID().slice(0, 6)}@lab.test`, role: 'SPV', is_active: true, email_notifications: true, ...o });
const mkEq = (daysLeft: number, o: any = {}) => ({
  equipment_id: randomUUID(), equipment_name: 'Oven', inventory_code: `INV-${Math.random().toString(36).slice(2, 6)}`, is_active: true, status: 'available',
  next_calibration_date: day(daysLeft), room: { room_name: 'Lab A', pic: null }, ...o,
});

beforeEach(() => {
  state.equipment = [];
  state.users = [];
  state.logs = [];
  sendMail.mockReset();
  sendMail.mockResolvedValue('msg-1');
  emailQueue.reset();
  emailQueue.configure({ paused: true });
});

describe('pemilihan tahap', () => {
  it('30/7/1/hari-H/overdue, selain itu null', () => {
    expect([30, 7, 1, 0, -1, -10].map(emailStageFor)).toEqual(['calibration_30d', 'calibration_7d', 'calibration_1d', 'calibration_1d', 'calibration_overdue', 'calibration_overdue']);
    expect([31, 29, 15, 8, 6, 2].map(emailStageFor)).toEqual([null, null, null, null, null, null]);
  });
  it('daysUntil memakai tanggal palsu', () => {
    expect(daysUntil(day(7), TODAY)).toBe(7);
    expect(daysUntil(day(-3), TODAY)).toBe(-3);
  });
});

describe('penerima', () => {
  it('hilangkan duplikat (PIC yang juga SPV) dan lewati email_notifications=false / nonaktif', () => {
    const pic = mkUser({ role: 'SPV' });
    const other = mkUser();
    const off = mkUser({ email_notifications: false });
    const inactive = mkUser({ is_active: false });
    const r = recipientsForEquipment(pic, [pic, other, off, inactive]);
    expect(r.map((u) => u.user_id).sort()).toEqual([pic.user_id, other.user_id].sort());
    expect(recipientsForEquipment(off, [])).toEqual([]);
  });
});

describe('job email kalibrasi', () => {
  it('satu digest per penerima, melewati alat nonaktif/calibration, dry_run tidak mencatat apa pun', async () => {
    const spv = mkUser();
    state.users.push(spv);
    state.equipment.push(mkEq(30), mkEq(7), mkEq(-2), mkEq(15), mkEq(7, { is_active: false }), mkEq(7, { status: 'calibration' }));
    const dry: any = await runCalibrationEmailReminders(NOW, { dryRun: true });
    expect(dry.emails).toHaveLength(1);
    expect(dry.emails[0]).toMatchObject({ to: spv.email, item_count: 3 });
    expect(dry.emails[0].subject.startsWith('PENTING: [Lab] 3 alat')).toBe(true);
    expect(state.logs).toHaveLength(0);
  });

  it('idempoten: dua kali pada hari yang sama hanya menghasilkan satu email per penerima', async () => {
    state.users.push(mkUser(), mkUser());
    state.equipment.push(mkEq(7), mkEq(1));
    const a: any = await runCalibrationEmailReminders(NOW);
    const b: any = await runCalibrationEmailReminders(NOW);
    expect(a.queued).toBe(2);
    expect(b.queued).toBe(0);
    expect(state.logs.filter((l) => l.reminder_type === 'digest')).toHaveLength(2);
    expect(state.logs.filter((l) => l.parent_id)).toHaveLength(4);
    expect(emailQueue.held).toHaveLength(2);
  });

  it('overdue diulang tiap 3 hari setelah terkirim', async () => {
    state.users.push(mkUser());
    state.equipment.push(mkEq(-1));
    await runCalibrationEmailReminders(NOW);
    const digest = state.logs.find((l) => l.reminder_type === 'digest')!;
    expect((await deliverEmail(digest.email_log_id)).ok).toBe(true);
    const plus2: any = await planCalibrationEmails(new Date(NOW.getTime() + 2 * 86_400_000));
    const plus3: any = await planCalibrationEmails(new Date(NOW.getTime() + 3 * 86_400_000));
    expect(plus2).toHaveLength(0);
    expect(plus3).toHaveLength(1);
  });

  it('kalibrasi ulang: next_calibration_date berubah → siklus pengingat baru', async () => {
    state.users.push(mkUser());
    const e = mkEq(7);
    state.equipment.push(e);
    await runCalibrationEmailReminders(NOW);
    expect(((await runCalibrationEmailReminders(NOW)) as any).queued).toBe(0);
    e.next_calibration_date = day(37); // dikalibrasi ulang
    const later = new Date(NOW.getTime() + 30 * 86_400_000); // 37 - 30 = 7 hari lagi
    expect(((await runCalibrationEmailReminders(later)) as any).queued).toBe(1);
    expect(state.logs.filter((l) => l.reminder_type === 'calibration_7d')).toHaveLength(2);
  });

  it('tidak ada alat → tidak ada email', async () => {
    state.users.push(mkUser());
    state.equipment.push(mkEq(15));
    expect(((await runCalibrationEmailReminders(NOW)) as any).recipients).toBe(0);
    expect(state.logs).toHaveLength(0);
  });
});

describe('pengiriman', () => {
  async function queueOne() {
    state.users.push(mkUser());
    state.equipment.push(mkEq(7));
    await runCalibrationEmailReminders(NOW);
    return state.logs.find((l) => l.reminder_type === 'digest')!;
  }

  it('kegagalan SMTP: status failed, attempts bertambah, tidak melempar; penanda ikut failed', async () => {
    const d = await queueOne();
    sendMail.mockRejectedValue(new Error('ECONNREFUSED'));
    // EMAIL_ENABLED default false di test → paksa jalur SMTP
    const { env } = await import('../src/config/env');
    (env as any).EMAIL_ENABLED = true;
    const r1 = await deliverEmail(d.email_log_id);
    const r2 = await deliverEmail(d.email_log_id);
    expect(r1).toMatchObject({ ok: false, status: 'failed' });
    expect(r2.ok).toBe(false);
    expect(d).toMatchObject({ status: 'failed', attempts: 2, error_message: 'ECONNREFUSED' });
    expect(state.logs.filter((l) => l.parent_id).every((l) => l.status === 'failed')).toBe(true);
    // pulih: kirim ulang berhasil
    sendMail.mockResolvedValue('ok-1');
    expect((await deliverEmail(d.email_log_id)).ok).toBe(true);
    expect(d).toMatchObject({ status: 'sent', attempts: 3, provider_message_id: 'ok-1' });
    // idempoten: sudah sent → tidak kirim lagi
    const calls = sendMail.mock.calls.length;
    await deliverEmail(d.email_log_id);
    expect(sendMail.mock.calls.length).toBe(calls);
    (env as any).EMAIL_ENABLED = false;
  });

  it('EMAIL_ENABLED=false: tidak memanggil SMTP, status tetap sent (dev-log)', async () => {
    const d = await queueOne();
    await deliverEmail(d.email_log_id);
    expect(sendMail).not.toHaveBeenCalled();
    expect(d).toMatchObject({ status: 'sent', provider_message_id: 'dev-log' });
  });
});

describe('template', () => {
  it('meng-escape teks dari database dan memuat tautan', () => {
    const r = renderDigest({
      kind: 'digest', recipient_name: '<b>Budi</b>',
      items: [{ equipment_id: 'e1', equipment_name: '<script>alert(1)</script>', inventory_code: 'A&B', room_name: 'R"1', due_date: '2026-11-09', days_left: 7, stage: 'calibration_7d' }],
    });
    expect(r.html).not.toContain('<script>');
    expect(r.html).toContain('&lt;script&gt;');
    expect(r.html).toContain('A&amp;B');
    expect(r.html).toContain('/calibration');
    expect(r.html).toContain('/equipment/e1');
    expect(r.text).toContain('H-7');
    expect(r.subject).toBe('[Lab] 1 alat mendekati jatuh tempo kalibrasi');
  });
});

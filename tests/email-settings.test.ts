/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ───────── fake DB: hanya tabel app_settings ─────────
const rows = new Map<string, { key: string; value: any; updated_at: Date; updated_by: string | null }>();
const fakeDb: any = {
  appSetting: {
    findUnique: async ({ where }: any) => rows.get(where.key) ?? null,
    upsert: async ({ where, create, update }: any) => {
      const cur = rows.get(where.key);
      const row = cur ? { ...cur, ...update, updated_at: new Date() } : { ...create, updated_at: new Date() };
      rows.set(where.key, row);
      return row;
    },
    deleteMany: async ({ where }: any) => ({ count: rows.delete(where.key) ? 1 : 0 }),
  },
};
vi.mock('../src/config/db', () => ({ getDb: () => fakeDb, disconnectDb: async () => {} }));

import { env } from '../src/config/env';
import {
  DEFAULT_JOB_TIME,
  decryptSecret,
  encryptSecret,
  mergeSettings,
  timeToCron,
  toPublic,
} from '../src/modules/email/email-settings.core';
import {
  currentEmailSettings,
  envDefaults,
  getEmailSettingsView,
  loadEmailSettings,
  onCalibrationJobTimeChange,
  resetEmailSettings,
  resetEmailSettingsCache,
  updateEmailSettings,
} from '../src/modules/email/email-settings';
import { updateEmailSettingsBody } from '../src/modules/email/email.schema';

beforeEach(() => {
  rows.clear();
  resetEmailSettingsCache();
  onCalibrationJobTimeChange(null);
});

describe('email-settings.core', () => {
  it('enkripsi password bolak-balik; kunci salah atau token rusak → null', () => {
    const t = encryptSecret('rahasia-smtp', 'kunci-1-kunci-1-kunci-1');
    expect(t).not.toContain('rahasia-smtp');
    expect(decryptSecret(t, 'kunci-1-kunci-1-kunci-1')).toBe('rahasia-smtp');
    expect(decryptSecret(t, 'kunci-lain-kunci-lain')).toBeNull();
    expect(decryptSecret('bukan-token', 'kunci-1-kunci-1-kunci-1')).toBeNull();
    expect(encryptSecret('a', 'k'.repeat(20))).not.toBe(encryptSecret('a', 'k'.repeat(20))); // IV acak
  });

  it('timeToCron: HH:mm → cron; tidak valid jatuh ke 07:00', () => {
    expect(timeToCron('07:00')).toBe('0 7 * * *');
    expect(timeToCron('18:45')).toBe('45 18 * * *');
    expect(timeToCron('00:05')).toBe('5 0 * * *');
    expect(timeToCron('25:99')).toBe('0 7 * * *');
  });

  it('mergeSettings: nilai tersimpan menimpa default, sisanya default; toPublic tanpa password', () => {
    const d = { ...envDefaults(), smtp_pass: 'dari-env' };
    const m = mergeSettings(d, { calibration_email_mode: 'manual', smtp_user: '', smtp_pass_enc: encryptSecret('baru', 's'.repeat(20)) }, 's'.repeat(20));
    expect(m.calibration_email_mode).toBe('manual');
    expect(m.smtp_user).toBe(''); // string kosong tetap menimpa
    expect(m.smtp_host).toBe(d.smtp_host);
    expect(m.smtp_pass).toBe('baru');
    const pub: any = toPublic(m);
    expect(pub.smtp_pass).toBeUndefined();
    expect(pub.smtp_pass_set).toBe(true);
  });
});

describe('email-settings (database)', () => {
  it('tanpa data tersimpan = default .env', async () => {
    const s = await loadEmailSettings();
    expect(s.calibration_email_mode).toBe(env.CALIBRATION_EMAIL_MODE);
    expect(s.calibration_job_time).toBe(DEFAULT_JOB_TIME);
    const v = await getEmailSettingsView();
    expect(v.using_defaults).toBe(true);
    expect(v.updated_at).toBeNull();
  });

  it('update: berlaku langsung, password terenkripsi dan tidak pernah dikembalikan', async () => {
    const v: any = await updateEmailSettings(
      { email_enabled: true, calibration_email_mode: 'manual', smtp_host: 'smtp.contoh.id', smtp_port: 587, smtp_user: 'lab@contoh.id', smtp_pass: 'sandi-rahasia', overdue_repeat_days: 5 },
      '11111111-1111-1111-1111-111111111111',
    );
    expect(v).toMatchObject({ email_enabled: true, calibration_email_mode: 'manual', smtp_host: 'smtp.contoh.id', smtp_port: 587, smtp_pass_set: true, using_defaults: false, overdue_repeat_days: 5 });
    expect(JSON.stringify(v)).not.toContain('sandi-rahasia');
    expect(JSON.stringify([...rows.values()])).not.toContain('sandi-rahasia'); // di DB juga terenkripsi

    const eff = await loadEmailSettings();
    expect(eff.smtp_pass).toBe('sandi-rahasia'); // server tetap bisa memakainya
    expect(eff.calibration_email_mode).toBe('manual');
    expect(currentEmailSettings().smtp_host).toBe('smtp.contoh.id');
    expect(rows.get('email')?.updated_by).toBe('11111111-1111-1111-1111-111111111111');
  });

  it('update parsial: password lama tetap bila smtp_pass kosong; clear_smtp_pass menghapus', async () => {
    await updateEmailSettings({ smtp_pass: 'abc123' }, null);
    await updateEmailSettings({ smtp_pass: '', smtp_port: 2525 }, null);
    expect((await loadEmailSettings()).smtp_pass).toBe('abc123');
    expect((await loadEmailSettings()).smtp_port).toBe(2525);
    const v = await updateEmailSettings({ clear_smtp_pass: true }, null);
    expect(v.smtp_pass_set).toBe(env.SMTP_PASS ? true : false);
    expect((await loadEmailSettings()).smtp_pass).toBe(env.SMTP_PASS ?? '');
  });

  it('jam job berubah → listener dipanggil; sama → tidak', async () => {
    const cb = vi.fn();
    onCalibrationJobTimeChange(cb);
    await updateEmailSettings({ calibration_job_time: '09:30' }, null);
    expect(cb).toHaveBeenCalledWith('09:30');
    await updateEmailSettings({ calibration_job_time: '09:30', email_enabled: true }, null);
    expect(cb).toHaveBeenCalledTimes(1);
    await resetEmailSettings();
    expect(cb).toHaveBeenLastCalledWith(DEFAULT_JOB_TIME);
  });

  it('reset: kembali ke default .env', async () => {
    await updateEmailSettings({ calibration_email_mode: 'manual', smtp_host: 'x.example' }, null);
    const v = await resetEmailSettings();
    expect(v.using_defaults).toBe(true);
    expect(v.smtp_host).toBe(env.SMTP_HOST);
  });

  it('DB bermasalah: pakai default .env, tidak melempar', async () => {
    const orig = fakeDb.appSetting.findUnique;
    fakeDb.appSetting.findUnique = async () => {
      throw new Error('tabel belum ada');
    };
    try {
      await expect(loadEmailSettings()).resolves.toMatchObject({ smtp_host: env.SMTP_HOST });
    } finally {
      fakeDb.appSetting.findUnique = orig;
    }
  });
});

describe('validasi body PATCH /admin/settings/email', () => {
  const parse = (b: unknown) => updateEmailSettingsBody.safeParse(b);
  it('menerima perubahan parsial yang valid', () => {
    expect(parse({ calibration_email_mode: 'manual' }).success).toBe(true);
    expect(parse({ calibration_job_time: '07:30', smtp_port: 465, smtp_secure: true }).success).toBe(true);
  });
  it('menolak body kosong, field asing, jam/port/mode/URL tidak valid', () => {
    expect(parse({}).success).toBe(false);
    expect(parse({ role: 'admin' }).success).toBe(false);
    expect(parse({ calibration_job_time: '7:30' }).success).toBe(false);
    expect(parse({ calibration_job_time: '24:00' }).success).toBe(false);
    expect(parse({ smtp_port: 70000 }).success).toBe(false);
    expect(parse({ calibration_email_mode: 'kadang' }).success).toBe(false);
    expect(parse({ frontend_url: 'bukan-url' }).success).toBe(false);
    expect(parse({ overdue_repeat_days: 0 }).success).toBe(false);
  });
});

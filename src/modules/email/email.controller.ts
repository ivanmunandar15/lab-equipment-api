import { runCalibrationJob } from '../../jobs/calibration.job';
import { runJob } from '../../jobs/runner';
import { asyncHandler } from '../../utils/async-handler';
import { ok, paginated } from '../../utils/response';
import { runCalibrationEmailReminders } from './calibration-reminders';
import { getEmailSettingsView, loadEmailSettings, resetEmailSettings, updateEmailSettings } from './email-settings';
import { verifySmtpConnection } from './mailer';
import * as service from './email.service';
import type { ListEmailLogsQuery, SendRemindersBody, UpdateEmailSettingsBody } from './email.schema';

export const updatePreferences = asyncHandler(async (req, res) => {
  ok(res, await service.setPreference(req.user!.user_id, req.body.email_notifications));
});

export const list = asyncHandler(async (req, res) => {
  const { items, meta } = await service.list(req.query as unknown as ListEmailLogsQuery);
  paginated(res, items, meta);
});

export const retry = asyncHandler(async (req, res) => {
  ok(res, await service.retry(req.params.id));
});

export const sendTest = asyncHandler(async (req, res) => {
  const u = req.user!;
  ok(res, await service.sendTest({ user_id: u.user_id, email: u.email, name: u.name }));
});

export const runCalibrationReminders = asyncHandler(async (req, res) => {
  const dry = (req.query as unknown as { dry_run: boolean }).dry_run;
  if (dry) {
    const s = await loadEmailSettings();
    return ok(res, { ...(await runCalibrationEmailReminders(new Date(), { dryRun: true })), mode: s.calibration_email_mode, email_enabled: s.email_enabled });
  }
  const result = await runJob({ name: 'calibration-reminders', run: () => runCalibrationJob() });
  ok(res, { dry_run: false, result: result ?? { skipped: 'job sedang berjalan atau gagal, lihat log' } });
});

/** Kirim email pengingat HANYA ke penerima terpilih (hasil pratinjau dry_run). Email diantrekan; status akhir ada di log. */
export const sendCalibrationReminders = asyncHandler(async (req, res) => {
  const result = await runCalibrationEmailReminders(new Date(), { userIds: (req.body as SendRemindersBody).user_ids });
  ok(res, { ...result, email_enabled: (await loadEmailSettings()).email_enabled });
});

/** Pengaturan email (admin): dibaca/diubah dari frontend, menimpa default .env. Password SMTP tidak pernah dikembalikan. */
export const getSettings = asyncHandler(async (_req, res) => {
  ok(res, await getEmailSettingsView());
});

export const updateSettings = asyncHandler(async (req, res) => {
  ok(res, await updateEmailSettings(req.body as UpdateEmailSettingsBody, req.user!.user_id));
});

export const resetSettings = asyncHandler(async (_req, res) => {
  ok(res, await resetEmailSettings());
});

export const testSmtpConnection = asyncHandler(async (_req, res) => {
  ok(res, await verifySmtpConnection());
});

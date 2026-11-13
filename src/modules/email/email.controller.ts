import { runCalibrationJob } from '../../jobs/calibration.job';
import { runJob } from '../../jobs/runner';
import { asyncHandler } from '../../utils/async-handler';
import { ok, paginated } from '../../utils/response';
import { runCalibrationEmailReminders } from './calibration-reminders';
import * as service from './email.service';
import type { ListEmailLogsQuery } from './email.schema';

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
  if (dry) return ok(res, await runCalibrationEmailReminders(new Date(), { dryRun: true }));
  const result = await runJob({ name: 'calibration-reminders', run: () => runCalibrationJob() });
  ok(res, { dry_run: false, result: result ?? { skipped: 'job sedang berjalan atau gagal, lihat log' } });
});

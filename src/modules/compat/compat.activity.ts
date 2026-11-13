import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import { getDb } from '../../config/db';
import { PERMISSIONS } from '../../config/permissions';
import { authorize } from '../../middlewares/rbac';
import { AppError } from '../../utils/errors';
import { LIST_CAP, h, idParam, isUuid, send, str } from './compat.http';
import { toActivityLog } from './compat.mappers';

export const activityRouter = Router();
activityRouter.use(authorize(...PERMISSIONS.activityLogs.read));

/**
 * Log bersifat append-only (dibuat otomatis oleh endpoint lain). `action` pada respons memakai kosakata frontend
 * (create/update/soft_delete/restore/delete/return/report/login), sehingga filter `action` dan `search`
 * dievaluasi pada nilai turunan itu (pada maksimal LIST_CAP log terbaru yang cocok dengan filter lain).
 */
activityRouter.get('/', h(async (req, res) => {
  const userId = str(req.query.user_id);
  const entityType = str(req.query.entity_type);
  const entityId = str(req.query.entity_id);
  const action = str(req.query.action);
  const search = str(req.query.search)?.toLowerCase();
  const from = str(req.query.from);
  const to = str(req.query.to);
  if (userId && !isUuid(userId)) return send(res, []);
  const where: Prisma.ActivityLogWhereInput = {
    ...(userId ? { user_id: userId } : {}),
    ...(entityType ? { entity_type: entityType } : {}),
    ...(entityId ? { entity_id: entityId } : {}),
    ...(from || to
      ? { created_at: { ...(from && !Number.isNaN(Date.parse(from)) ? { gte: new Date(from) } : {}), ...(to && !Number.isNaN(Date.parse(to)) ? { lte: new Date(to) } : {}) } }
      : {}),
  };
  const rows = await getDb().activityLog.findMany({
    where, orderBy: { created_at: 'desc' }, take: LIST_CAP, include: { user: { select: { name: true } } },
  });
  const out = rows
    .map((r) => ({ log: toActivityLog(r), user_name: r.user?.name }))
    .filter(({ log }) => !action || log.action === action)
    .filter(({ log, user_name }) => !search || [log.action, log.entity_type, log.entity_id, user_name].some((x) => x?.toLowerCase().includes(search)))
    .map(({ log }) => log);
  send(res, out);
}));

activityRouter.get('/:id', h(async (req, res) => {
  const row = await getDb().activityLog.findUnique({ where: { log_id: idParam(req, 'id', 'Log aktivitas') } });
  if (!row) throw AppError.notFound(`Log aktivitas dengan ID "${req.params.id}" tidak ditemukan`);
  send(res, toActivityLog(row));
}));

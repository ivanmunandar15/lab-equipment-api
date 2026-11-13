import type { Request } from 'express';
import { asyncHandler } from '../../utils/async-handler';
import { created, ok, paginated } from '../../utils/response';
import * as service from './calibrations.service';

const actorOf = (req: Request): service.Actor => ({ userId: req.user!.user_id, ip: req.ip ?? null });

export const list = asyncHandler(async (req, res) => {
  const { items, meta } = await service.list(req.query as never);
  paginated(res, items, meta);
});
export const getById = asyncHandler(async (req, res) => ok(res, await service.getById(req.params.id)));
export const schedule = asyncHandler(async (req, res) => {
  const { month, room_id } = req.query as { month: string; room_id?: string };
  ok(res, await service.schedule(month, room_id));
});
export const summary = asyncHandler(async (req, res) => ok(res, await service.summary((req.query as { room_id?: string }).room_id)));
export const create = asyncHandler(async (req, res) => created(res, await service.create(req.body, req.file, actorOf(req))));
export const startCalibration = asyncHandler(async (req, res) => ok(res, await service.startCalibration(req.params.id, actorOf(req))));

export const certificate = asyncHandler(async (req, res) => {
  const f = await service.openCertificate(req.params.id);
  res.setHeader('Content-Type', f.mime);
  res.setHeader('Content-Length', String(f.size));
  res.setHeader('Content-Disposition', `inline; filename="${f.filename}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  f.stream.on('error', (e) => (res.headersSent ? res.destroy(e) : res.status(500).end()));
  f.stream.pipe(res);
});


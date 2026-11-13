import type { Request } from 'express';
import { asyncHandler } from '../../utils/async-handler';
import { created, ok, paginated } from '../../utils/response';
import type { ListDocumentsQuery } from './documents.schema';
import * as service from './documents.service';

const actorOf = (req: Request): service.Actor => ({ userId: req.user!.user_id, role: req.user!.role, ip: req.ip ?? null });

export const list = asyncHandler(async (req, res) => {
  const { items, meta } = await service.list(req.query as unknown as ListDocumentsQuery);
  paginated(res, items, meta);
});
export const getById = asyncHandler(async (req, res) => ok(res, await service.getById(req.params.id)));
export const create = asyncHandler(async (req, res) => created(res, await service.create(req.body, req.file, actorOf(req))));
export const remove = asyncHandler(async (req, res) => ok(res, await service.remove(req.params.id, actorOf(req))));

export const download = asyncHandler(async (req, res) => {
  const inline = (req.query as { inline?: boolean }).inline === true;
  const f = await service.openDownload(req.params.id, actorOf(req), inline);
  const ascii = f.filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  res.setHeader('Content-Type', f.mime);
  res.setHeader('Content-Length', String(f.size));
  res.setHeader('Content-Disposition', `${f.disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(f.filename)}`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  f.stream.on('error', (e) => (res.headersSent ? res.destroy(e) : res.status(500).end()));
  f.stream.pipe(res);
});

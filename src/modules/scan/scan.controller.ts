import type { Request, Response } from 'express';
import { asyncHandler } from '../../utils/async-handler';
import { ok } from '../../utils/response';
import * as service from './scan.service';

const viewer = (req: Request): service.Viewer => ({ userId: req.user!.user_id, role: req.user!.role });
const noStore = (res: Response) => res.setHeader('Cache-Control', 'no-store');

export const equipment = asyncHandler(async (req, res) => {
  noStore(res);
  ok(res, await service.scanEquipment(req.params.qrToken, viewer(req)));
});
export const supporting = asyncHandler(async (req, res) => {
  noStore(res);
  ok(res, await service.scanSupporting(req.params.qrToken, viewer(req)));
});

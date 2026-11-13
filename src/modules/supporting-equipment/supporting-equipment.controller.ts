import { asyncHandler } from '../../utils/async-handler';
import { AppError } from '../../utils/errors';
import { created, ok, paginated } from '../../utils/response';
import { audit } from '../activity-logs/audit.service';
import { importTemplateCsv, importCsv } from './supporting-equipment.import';
import * as exporter from './supporting-equipment.export';
import type { ImportBody } from '../equipment/equipment.schema';
import type { ExportSupportingQuery, ListSupportingQuery } from './supporting-equipment.schema';
import * as service from './supporting-equipment.service';

const q = <T>(req: { query: unknown }) => req.query as T;

export const list = asyncHandler(async (req, res) => {
  const { items, meta } = await service.list(q<ListSupportingQuery>(req));
  paginated(res, items, meta);
});
export const getById = asyncHandler(async (req, res) => ok(res, await service.getById(req.params.id)));
export const create = asyncHandler(async (req, res) => created(res, await service.create(req.body)));
export const update = asyncHandler(async (req, res) => ok(res, await service.update(req.params.id, req.body)));
export const remove = asyncHandler(async (req, res) => ok(res, await service.remove(req.params.id)));

export const qr = asyncHandler(async (req, res) => {
  const { size } = q<{ size: number }>(req);
  const { item_code, png } = await service.getQrPng(req.params.id, size);
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Content-Length', String(png.length));
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.setHeader('Content-Disposition', `inline; filename="${item_code.replace(/[^\w.-]+/g, '_')}.png"`);
  res.end(png);
});

export const exportCsv = asyncHandler(async (req, res) => {
  await exporter.streamCsv(service.buildWhere(q<ExportSupportingQuery>(req)), res);
});
export const exportZip = asyncHandler(async (req, res) => {
  await exporter.streamZip(service.buildWhere(q<ExportSupportingQuery>(req)), res);
});
export const labels = asyncHandler(async (req, res) => {
  const { ids, layout } = q<{ ids: string[]; layout: 'a4-3x8' | 'sticker-50x30' }>(req);
  await exporter.streamLabelsPdf(ids, layout, res);
});

export const importTemplate = asyncHandler(async (_req, res) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="supporting-equipment-import-template.csv"');
  res.send(importTemplateCsv());
});

export const importFile = asyncHandler(async (req, res) => {
  if (!req.file) {
    throw AppError.unprocessable('Validasi gagal', [{ path: 'file', message: 'File CSV wajib diunggah (field "file")' }]);
  }
  const { status, body } = await importCsv(req.file, req.body as ImportBody, audit.actorFrom(req));
  ok(res, body, undefined, status);
});

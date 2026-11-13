import { Router, type RequestHandler } from 'express';
import { PERMISSIONS } from '../../config/permissions';
import { auditCreate, auditDelete, auditExport, auditUpdate } from '../../middlewares/audit';
import { authenticate } from '../../middlewares/auth';
import { authorize } from '../../middlewares/rbac';
import { csvUpload } from '../../middlewares/upload';
import { validate } from '../../middlewares/validate';
import { AUDIT_ENTITIES } from '../activity-logs/audit.service';
import { importBody } from '../equipment/equipment.schema';
import * as c from './supporting-equipment.controller';
import {
  createSupportingBody,
  exportSupportingQuery,
  idParams,
  labelsSupportingQuery,
  listSupportingQuery,
  qrQuery,
  updateSupportingBody,
} from './supporting-equipment.schema';
import { getBasic } from './supporting-equipment.service';

export const supportingEquipmentRouter = Router();

const read = authorize(...PERMISSIONS.supportingEquipment.read);
const write = authorize(...PERMISSIONS.supportingEquipment.write);
const E = AUDIT_ENTITIES.SUPPORTING_EQUIPMENT;
const loadOld = (req: { params: { id?: string } }) => getBasic(req.params.id as string);
// dry_run / all_or_nothing boleh dikirim sebagai field multipart ATAU query string
const mergeQueryIntoBody: RequestHandler = (req, _res, next) => {
  req.body = { ...req.query, ...req.body };
  next();
};

supportingEquipmentRouter.use(authenticate);

supportingEquipmentRouter.get('/', read, validate({ query: listSupportingQuery }), c.list);

// Rute statis harus didaftarkan SEBELUM '/:id'
supportingEquipmentRouter.get('/export.csv', read, validate({ query: exportSupportingQuery }), auditExport(E), c.exportCsv);
supportingEquipmentRouter.get('/export.zip', read, validate({ query: exportSupportingQuery }), auditExport(E), c.exportZip);
supportingEquipmentRouter.get('/labels.pdf', read, validate({ query: labelsSupportingQuery }), auditExport(E), c.labels);
supportingEquipmentRouter.get('/import-template.csv', write, c.importTemplate);
supportingEquipmentRouter.post('/import', write, csvUpload, mergeQueryIntoBody, validate({ body: importBody }), c.importFile);

supportingEquipmentRouter.post('/', write, validate({ body: createSupportingBody }), auditCreate(E), c.create);
supportingEquipmentRouter.get('/:id', read, validate({ params: idParams }), c.getById);
supportingEquipmentRouter.get('/:id/qr.png', read, validate({ params: idParams, query: qrQuery }), c.qr);
supportingEquipmentRouter.patch(
  '/:id',
  write,
  validate({ params: idParams, body: updateSupportingBody }),
  auditUpdate(E, loadOld),
  c.update,
);
supportingEquipmentRouter.delete('/:id', write, validate({ params: idParams }), auditDelete(E, loadOld), c.remove);

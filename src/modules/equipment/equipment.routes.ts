import { Router, type RequestHandler } from 'express';
import { PERMISSIONS } from '../../config/permissions';
import { auditCreate, auditDelete, auditExport, auditUpdate } from '../../middlewares/audit';
import { authenticate } from '../../middlewares/auth';
import { authorize } from '../../middlewares/rbac';
import { csvUpload } from '../../middlewares/upload';
import { validate } from '../../middlewares/validate';
import { AUDIT_ENTITIES } from '../activity-logs/audit.service';
import { startCalibration } from '../calibrations/calibrations.controller';
import * as c from './equipment.controller';
import { reportDamageBody } from '../borrowings/borrowings.schema';
import {
  borrowingsSubQuery,
  calibrationsSubQuery,
  createEquipmentBody,
  documentsSubQuery,
  exportQuery,
  idParams,
  importBody,
  labelsQuery,
  listEquipmentQuery,
  maintenancesSubQuery,
  qrQuery,
  updateEquipmentBody,
} from './equipment.schema';
import { getBasic } from './equipment.service';

export const equipmentRouter = Router();

const read = authorize(...PERMISSIONS.equipment.read);
const write = authorize(...PERMISSIONS.equipment.write);
const E = AUDIT_ENTITIES.EQUIPMENT;
const loadOld = (req: { params: { id?: string } }) => getBasic(req.params.id as string);
// dry_run / all_or_nothing boleh dikirim sebagai field multipart ATAU query string
const mergeQueryIntoBody: RequestHandler = (req, _res, next) => {
  req.body = { ...req.query, ...req.body };
  next();
};

equipmentRouter.use(authenticate);

equipmentRouter.get('/', read, validate({ query: listEquipmentQuery }), c.list);

// Rute statis harus didaftarkan SEBELUM '/:id'
equipmentRouter.get('/export.csv', read, validate({ query: exportQuery }), auditExport(E), c.exportCsv);
equipmentRouter.get('/export.zip', read, validate({ query: exportQuery }), auditExport(E), c.exportZip);
equipmentRouter.get('/labels.pdf', read, validate({ query: labelsQuery }), auditExport(E), c.labels);
equipmentRouter.get('/import-template.csv', write, c.importTemplate);
equipmentRouter.post('/import', write, csvUpload, mergeQueryIntoBody, validate({ body: importBody }), c.importFile);

equipmentRouter.post('/', write, validate({ body: createEquipmentBody }), auditCreate(E), c.create);
equipmentRouter.get('/:id', read, validate({ params: idParams }), c.getById);
equipmentRouter.get('/:id/qr.png', read, validate({ params: idParams, query: qrQuery }), c.qr);
equipmentRouter.get('/:id/borrowings', read, validate({ params: idParams, query: borrowingsSubQuery }), c.borrowings);
equipmentRouter.get('/:id/calibrations', read, validate({ params: idParams, query: calibrationsSubQuery }), c.calibrations);
equipmentRouter.get('/:id/maintenances', read, validate({ params: idParams, query: maintenancesSubQuery }), c.maintenances);
equipmentRouter.get('/:id/documents', read, validate({ params: idParams, query: documentsSubQuery }), c.documents);
equipmentRouter.post(
  '/:id/start-calibration',
  authorize(...PERMISSIONS.calibrations.write),
  validate({ params: idParams }),
  startCalibration,
);
equipmentRouter.post(
  '/:id/report-damage',
  authorize(...PERMISSIONS.equipment.reportDamage),
  validate({ params: idParams, body: reportDamageBody }),
  c.reportDamage,
);
equipmentRouter.patch(
  '/:id',
  write,
  validate({ params: idParams, body: updateEquipmentBody }),
  auditUpdate(E, loadOld),
  c.update,
);
equipmentRouter.delete('/:id', write, validate({ params: idParams }), auditDelete(E, loadOld), c.remove);

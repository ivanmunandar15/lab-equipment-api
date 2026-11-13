import { Router, type RequestHandler } from 'express';
import { PERMISSIONS } from '../../config/permissions';
import { authenticate } from '../../middlewares/auth';
import { authorize } from '../../middlewares/rbac';
import { certificateUpload } from '../../middlewares/upload';
import { validate } from '../../middlewares/validate';
import * as c from './calibrations.controller';
import { createCalibrationBody, idParams, listCalibrationsQuery, scheduleQuery, summaryQuery } from './calibrations.schema';

export const calibrationsRouter = Router();

const read = authorize(...PERMISSIONS.calibrations.read);
const write = authorize(...PERMISSIONS.calibrations.write);

/** Field kosong dari form multipart ('') dianggap tidak diisi. */
const blankToUndefined: RequestHandler = (req, _res, next) => {
  if (req.body && typeof req.body === 'object') {
    for (const k of Object.keys(req.body)) if (req.body[k] === '') delete req.body[k];
  }
  next();
};

calibrationsRouter.use(authenticate);

calibrationsRouter.get('/', read, validate({ query: listCalibrationsQuery }), c.list);
// Rute statis sebelum '/:id'
calibrationsRouter.get('/schedule', read, validate({ query: scheduleQuery }), c.schedule);
calibrationsRouter.get('/summary', read, validate({ query: summaryQuery }), c.summary);
calibrationsRouter.post('/', write, certificateUpload, blankToUndefined, validate({ body: createCalibrationBody }), c.create);
calibrationsRouter.get('/:id', read, validate({ params: idParams }), c.getById);
calibrationsRouter.get('/:id/certificate', read, validate({ params: idParams }), c.certificate);

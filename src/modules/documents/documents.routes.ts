import { Router } from 'express';
import { PERMISSIONS } from '../../config/permissions';
import { authenticate } from '../../middlewares/auth';
import { authorize } from '../../middlewares/rbac';
import { documentUpload } from '../../middlewares/upload';
import { validate } from '../../middlewares/validate';
import * as c from './documents.controller';
import { createDocumentBody, downloadQuery, idParams, listDocumentsQuery } from './documents.schema';

export const documentsRouter = Router();

const read = authorize(...PERMISSIONS.documents.read);
const upload = authorize(...PERMISSIONS.documents.upload);

documentsRouter.use(authenticate);

documentsRouter.get('/', read, validate({ query: listDocumentsQuery }), c.list);
documentsRouter.post('/', upload, documentUpload, validate({ body: createDocumentBody }), c.create);
documentsRouter.get('/:id', read, validate({ params: idParams }), c.getById);
documentsRouter.get('/:id/download', read, validate({ params: idParams, query: downloadQuery }), c.download);
// Izin akhir (admin/SPV atau pengunggah) diperiksa di service.
documentsRouter.delete('/:id', read, validate({ params: idParams }), c.remove);

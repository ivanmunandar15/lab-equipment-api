import { Router } from 'express';
import { PERMISSIONS } from '../../config/permissions';
import { authenticate } from '../../middlewares/auth';
import { authorize } from '../../middlewares/rbac';
import { validate } from '../../middlewares/validate';
import * as c from './borrowings.controller';
import { createBorrowingBody, idParams, listBorrowingsQuery, myBorrowingsQuery, returnBorrowingBody } from './borrowings.schema';

export const borrowingsRouter = Router();

const read = authorize(...PERMISSIONS.borrowings.read);
const write = authorize(...PERMISSIONS.borrowings.write);

borrowingsRouter.use(authenticate);

borrowingsRouter.get('/', read, validate({ query: listBorrowingsQuery }), c.list);
borrowingsRouter.get('/my', read, validate({ query: myBorrowingsQuery }), c.my); // sebelum '/:id'
borrowingsRouter.post('/', write, validate({ body: createBorrowingBody }), c.create);
borrowingsRouter.get('/:id', read, validate({ params: idParams }), c.getById);
// Hak mengembalikan (peminjam / admin / SPV) diperiksa di service karena butuh data peminjaman.
borrowingsRouter.post('/:id/return', write, validate({ params: idParams, body: returnBorrowingBody }), c.returnItems);

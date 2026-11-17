import { Router } from 'express';
import { createTransfer } from '../controllers/transfers.controller';
import { requireApiKey } from '../middlewares/auth.middleware';
import { idempotencyMiddleware } from '../middlewares/idempotency';
import { validateBody } from '../middlewares/validate.middleware';
import { createTransferSchema } from '../schemas/transfer.schema';

export const transfersRouter = Router();

transfersRouter.post(
  '/transfers',
  requireApiKey,
  idempotencyMiddleware,
  validateBody(createTransferSchema),
  createTransfer
);

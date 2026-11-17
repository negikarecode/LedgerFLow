import { Router } from 'express';
import {
  listOutboxEvents,
  getOutboxEvent,
  replayOutboxEvent,
  replayBatchOutboxEvents,
} from '../controllers/outbox.controller';
import { requireApiKey } from '../middlewares/auth.middleware';
import { validateParams } from '../middlewares/validate.middleware';
import { idParamSchema } from '../schemas/common.schema';

export const outboxRouter = Router();

outboxRouter.get('/outbox', requireApiKey, listOutboxEvents);
outboxRouter.post('/outbox/replay-batch', requireApiKey, replayBatchOutboxEvents);
outboxRouter.get('/outbox/:id', requireApiKey, validateParams(idParamSchema), getOutboxEvent);
outboxRouter.post('/outbox/:id/replay', requireApiKey, validateParams(idParamSchema), replayOutboxEvent);

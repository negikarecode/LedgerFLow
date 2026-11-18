import { Router } from 'express';
import {
  listOutboxEvents,
  getOutboxEvent,
  replayOutboxEvent,
  replayBatchOutboxEvents,
} from '../controllers/outbox.controller';
import { requireApiKey } from '../middlewares/auth.middleware';
import { tenantRateLimiter, expensiveRateLimiter } from '../middlewares/rate-limit.middleware';
import { validateParams } from '../middlewares/validate.middleware';
import { idParamSchema } from '../schemas/common.schema';

export const outboxRouter = Router();

outboxRouter.use('/outbox', requireApiKey, tenantRateLimiter);

outboxRouter.get('/outbox', listOutboxEvents);
outboxRouter.post('/outbox/replay-batch', expensiveRateLimiter, replayBatchOutboxEvents);
outboxRouter.get('/outbox/:id', validateParams(idParamSchema), getOutboxEvent);
outboxRouter.post('/outbox/:id/replay', validateParams(idParamSchema), replayOutboxEvent);

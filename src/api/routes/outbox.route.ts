import { Router } from 'express';
import { listOutboxEvents, replayOutboxEvent } from '../controllers/outbox.controller';
import { validateParams } from '../middlewares/validate.middleware';
import { idParamSchema } from '../schemas/common.schema';

export const outboxRouter = Router();

outboxRouter.get('/outbox', listOutboxEvents);
outboxRouter.post('/outbox/:id/replay', validateParams(idParamSchema), replayOutboxEvent);

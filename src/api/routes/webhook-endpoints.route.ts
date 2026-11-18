import { Router } from 'express';
import {
  createWebhookEndpoint,
  listWebhookEndpoints,
  getWebhookEndpoint,
  deleteWebhookEndpoint,
  rotateWebhookEndpointSecret,
} from '../controllers/webhook-endpoints.controller';
import { requireApiKey } from '../middlewares/auth.middleware';
import { tenantRateLimiter, expensiveRateLimiter } from '../middlewares/rate-limit.middleware';
import { validateBody, validateParams } from '../middlewares/validate.middleware';
import { idParamSchema } from '../schemas/common.schema';
import { createWebhookEndpointSchema } from '../schemas/webhook-endpoint.schema';

export const webhookEndpointsRouter = Router();

webhookEndpointsRouter.use('/webhook-endpoints', requireApiKey, tenantRateLimiter);

webhookEndpointsRouter.post(
  '/webhook-endpoints',
  expensiveRateLimiter,
  validateBody(createWebhookEndpointSchema),
  createWebhookEndpoint
);

webhookEndpointsRouter.get(
  '/webhook-endpoints',
  listWebhookEndpoints
);

webhookEndpointsRouter.get(
  '/webhook-endpoints/:id',
  validateParams(idParamSchema),
  getWebhookEndpoint
);

webhookEndpointsRouter.delete(
  '/webhook-endpoints/:id',
  validateParams(idParamSchema),
  deleteWebhookEndpoint
);

webhookEndpointsRouter.post(
  '/webhook-endpoints/:id/rotate-secret',
  expensiveRateLimiter,
  validateParams(idParamSchema),
  rotateWebhookEndpointSecret
);

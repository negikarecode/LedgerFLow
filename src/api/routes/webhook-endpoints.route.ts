import { Router } from 'express';
import {
  createWebhookEndpoint,
  listWebhookEndpoints,
  deleteWebhookEndpoint,
  rotateWebhookEndpointSecret,
} from '../controllers/webhook-endpoints.controller';
import { requireApiKey } from '../middlewares/auth.middleware';
import { validateBody, validateParams } from '../middlewares/validate.middleware';
import { idParamSchema } from '../schemas/common.schema';
import { createWebhookEndpointSchema } from '../schemas/webhook-endpoint.schema';

export const webhookEndpointsRouter = Router();

webhookEndpointsRouter.post(
  '/webhook-endpoints',
  requireApiKey,
  validateBody(createWebhookEndpointSchema),
  createWebhookEndpoint
);

webhookEndpointsRouter.get(
  '/webhook-endpoints',
  requireApiKey,
  listWebhookEndpoints
);

webhookEndpointsRouter.delete(
  '/webhook-endpoints/:id',
  requireApiKey,
  validateParams(idParamSchema),
  deleteWebhookEndpoint
);

webhookEndpointsRouter.post(
  '/webhook-endpoints/:id/rotate-secret',
  requireApiKey,
  validateParams(idParamSchema),
  rotateWebhookEndpointSecret
);

import { Router } from 'express';
import { getHealth, getLiveness, getReadiness } from '../controllers/health.controller';

export const healthRouter = Router();

healthRouter.get('/health', getHealth);
healthRouter.get('/health/live', getLiveness);
healthRouter.get('/livez', getLiveness);
healthRouter.get('/health/ready', getReadiness);
healthRouter.get('/readyz', getReadiness);

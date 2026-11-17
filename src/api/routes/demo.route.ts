import { Router } from 'express';
import { resetDemoState } from '../controllers/demo.controller';
import { requireDemoMode } from '../middlewares/demo.middleware';

export const demoRouter = Router();

// Gate demo reset behind DEMO_MODE
demoRouter.use('/demo', requireDemoMode);

demoRouter.post('/demo/reset', resetDemoState);

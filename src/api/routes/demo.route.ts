import { Router } from 'express';
import { resetDemoState } from '../controllers/demo.controller';

export const demoRouter = Router();

demoRouter.post('/demo/reset', resetDemoState);

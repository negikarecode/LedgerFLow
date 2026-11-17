import { Router } from 'express';
import {
  handleMerchantWebhook,
  toggleMerchantCrash,
  getMerchantStatus,
  resetMerchant,
} from '../controllers/merchant.controller';
import { requireDemoMode } from '../middlewares/demo.middleware';

export const merchantRouter = Router();

// Webhook receiver endpoint (accepts incoming signed payloads)
merchantRouter.post('/mock-merchant/webhook', handleMerchantWebhook);

// Simulation & destructive demo endpoints - gated behind DEMO_MODE
merchantRouter.post('/mock-merchant/crash', requireDemoMode, toggleMerchantCrash);
merchantRouter.get('/mock-merchant/status', requireDemoMode, getMerchantStatus);
merchantRouter.post('/mock-merchant/reset', requireDemoMode, resetMerchant);

import { Router } from 'express';
import {
  handleMerchantWebhook,
  toggleMerchantCrash,
  getMerchantStatus,
  resetMerchant,
} from '../controllers/merchant.controller';

export const merchantRouter = Router();

merchantRouter.post('/mock-merchant/webhook', handleMerchantWebhook);
merchantRouter.post('/mock-merchant/crash', toggleMerchantCrash);
merchantRouter.get('/mock-merchant/status', getMerchantStatus);
merchantRouter.post('/mock-merchant/reset', resetMerchant);

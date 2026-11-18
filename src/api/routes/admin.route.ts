import { Router } from 'express';
import { requireAdminToken } from '../middlewares/auth.middleware';
import { expensiveRateLimiter } from '../middlewares/rate-limit.middleware';
import {
  createMerchant,
  createMerchantKey,
  revokeApiKey,
  handleAdminReconcile,
} from '../controllers/admin.controller';

export const adminRouter = Router();

// All admin routes are protected by ADMIN_TOKEN
adminRouter.use('/admin', requireAdminToken);

adminRouter.post('/admin/merchants', createMerchant);
adminRouter.post('/admin/merchants/:id/keys', createMerchantKey);
adminRouter.post('/admin/keys/:id/revoke', revokeApiKey);
adminRouter.post('/admin/reconcile', expensiveRateLimiter, handleAdminReconcile);

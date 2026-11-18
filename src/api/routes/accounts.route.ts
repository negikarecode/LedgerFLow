import { Router } from 'express';
import {
  createAccount,
  listAccounts,
  getAccountById,
  getAccountLedger,
} from '../controllers/accounts.controller';
import { requireApiKey } from '../middlewares/auth.middleware';
import { tenantRateLimiter } from '../middlewares/rate-limit.middleware';
import {
  validateBody,
  validateParams,
  validateQuery,
} from '../middlewares/validate.middleware';
import {
  createAccountSchema,
  accountParamsSchema,
} from '../schemas/account.schema';
import { paginationQuerySchema } from '../schemas/common.schema';

export const accountsRouter = Router();

// Protect all account routes with API-key authentication and tenant rate limiting
accountsRouter.use('/accounts', requireApiKey, tenantRateLimiter);

accountsRouter.get(
  '/accounts',
  validateQuery(paginationQuerySchema),
  listAccounts
);

accountsRouter.post(
  '/accounts',
  validateBody(createAccountSchema),
  createAccount
);

accountsRouter.get(
  '/accounts/:id/ledger',
  validateParams(accountParamsSchema),
  getAccountLedger
);

accountsRouter.get(
  '/accounts/:id',
  validateParams(accountParamsSchema),
  getAccountById
);

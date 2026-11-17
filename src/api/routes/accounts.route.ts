import { Router } from 'express';
import {
  createAccount,
  listAccounts,
  getAccountById,
  getAccountLedger,
} from '../controllers/accounts.controller';
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

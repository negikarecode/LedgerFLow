import { Router } from 'express';
import swaggerUi from 'swagger-ui-express';

export const openApiSpec = {
  openapi: '3.0.0',
  info: {
    title: 'LedgerFlow API',
    version: '1.0.0',
    description:
      'Idempotent double-entry payment and webhook delivery engine REST API. Amounts are represented in paise (1 INR = 100 paise).',
  },
  servers: [
    {
      url: '/',
      description: 'Current Environment Server',
    },
  ],
  tags: [
    { name: 'Health', description: 'System health checks' },
    { name: 'Accounts', description: 'Double-entry account management' },
  ],
  paths: {
    '/health': {
      get: {
        tags: ['Health'],
        summary: 'System health check',
        description: 'Verifies PostgreSQL (SELECT 1) and Redis (PING) connectivity.',
        responses: {
          '200': {
            description: 'All services healthy',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/HealthResponse',
                },
              },
            },
          },
          '503': {
            description: 'One or more services unavailable',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/HealthResponse',
                },
              },
            },
          },
        },
      },
    },
    '/accounts': {
      get: {
        tags: ['Accounts'],
        summary: 'List accounts',
        description: 'Retrieves accounts with current balances calculated from the double-entry ledger.',
        parameters: [
          {
            name: 'limit',
            in: 'query',
            description: 'Number of accounts to return (max 100)',
            schema: { type: 'integer', default: 50 },
          },
          {
            name: 'offset',
            in: 'query',
            description: 'Number of accounts to skip',
            schema: { type: 'integer', default: 0 },
          },
        ],
        responses: {
          '200': {
            description: 'List of accounts retrieved successfully',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/AccountListResponse',
                },
              },
            },
          },
        },
      },
      post: {
        tags: ['Accounts'],
        summary: 'Create test account / wallet',
        description: 'Creates a new account and optionally credits it with an initial seed balance in paise.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/CreateAccountRequest',
              },
            },
          },
        },
        responses: {
          '201': {
            description: 'Account created successfully',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/Account',
                },
              },
            },
          },
          '400': {
            description: 'Validation error',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/ErrorResponse',
                },
              },
            },
          },
        },
      },
    },
    '/accounts/{id}': {
      get: {
        tags: ['Accounts'],
        summary: 'Get account by ID',
        description: 'Retrieves an account by its UUID with balance and recent ledger entries.',
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            description: 'UUID of the account',
            schema: { type: 'string', format: 'uuid' },
          },
        ],
        responses: {
          '200': {
            description: 'Account details found',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/AccountDetail',
                },
              },
            },
          },
          '404': {
            description: 'Account not found',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/ErrorResponse',
                },
              },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      HealthResponse: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['ok', 'degraded'] },
          timestamp: { type: 'string', format: 'date-time' },
          services: {
            type: 'object',
            properties: {
              postgres: {
                type: 'object',
                properties: {
                  status: { type: 'string', enum: ['up', 'down'] },
                  latencyMs: { type: 'number' },
                  error: { type: 'string' },
                },
              },
              redis: {
                type: 'object',
                properties: {
                  status: { type: 'string', enum: ['up', 'down'] },
                  latencyMs: { type: 'number' },
                  error: { type: 'string' },
                },
              },
            },
          },
        },
      },
      CreateAccountRequest: {
        type: 'object',
        required: ['owner_name'],
        properties: {
          owner_name: { type: 'string', example: 'Alice Sharma' },
          currency: { type: 'string', default: 'INR', example: 'INR' },
          initial_credit_paise: {
            type: 'integer',
            minimum: 0,
            default: 0,
            example: 50000,
            description: 'Initial seed credit in paise (50000 = ₹500.00)',
          },
        },
      },
      Account: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          owner_name: { type: 'string' },
          currency: { type: 'string' },
          balance_paise: { type: 'integer' },
          initial_transaction_id: { type: 'string', format: 'uuid', nullable: true },
          created_at: { type: 'string', format: 'date-time' },
        },
      },
      AccountDetail: {
        allOf: [
          { $ref: '#/components/schemas/Account' },
          {
            type: 'object',
            properties: {
              recent_ledger_entries: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string', format: 'uuid' },
                    transaction_id: { type: 'string', format: 'uuid' },
                    entry_type: { type: 'string', enum: ['DEBIT', 'CREDIT'] },
                    amount: { type: 'integer' },
                    created_at: { type: 'string', format: 'date-time' },
                  },
                },
              },
            },
          },
        ],
      },
      AccountListResponse: {
        type: 'object',
        properties: {
          data: {
            type: 'array',
            items: { $ref: '#/components/schemas/Account' },
          },
          pagination: {
            type: 'object',
            properties: {
              total: { type: 'integer' },
              limit: { type: 'integer' },
              offset: { type: 'integer' },
            },
          },
        },
      },
      ErrorResponse: {
        type: 'object',
        properties: {
          error: { type: 'string' },
          message: { type: 'string' },
          details: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                field: { type: 'string' },
                message: { type: 'string' },
              },
            },
          },
        },
      },
    },
  },
};

export const docsRouter = Router();

docsRouter.get('/docs.json', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.send(openApiSpec);
});

docsRouter.use('/docs', swaggerUi.serve, swaggerUi.setup(openApiSpec));

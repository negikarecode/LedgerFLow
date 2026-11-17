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
    { name: 'Transfers', description: 'Idempotent double-entry fund transfers' },
    { name: 'Outbox', description: 'Transactional outbox inspection and replay' },
    { name: 'Mock Merchant', description: 'Mock merchant receiver for webhook demos' },
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
    '/accounts/{id}/ledger': {
      get: {
        tags: ['Accounts'],
        summary: 'Get account ledger history',
        description: 'Returns the account balance and chronological double-entry ledger entries.',
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
            description: 'Chronological ledger entries retrieved successfully',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/AccountLedgerResponse',
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
    '/transfers': {
      post: {
        tags: ['Transfers'],
        summary: 'Execute idempotent double-entry transfer',
        description:
          'Atomically transfers funds from one account to another using double-entry bookkeeping with deadlock-free row locking, idempotency guarantees, and transactional outbox event creation.',
        parameters: [
          {
            name: 'Idempotency-Key',
            in: 'header',
            required: true,
            description: 'Unique client-generated idempotency key (e.g. UUID)',
            schema: { type: 'string' },
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/CreateTransferRequest',
              },
            },
          },
        },
        responses: {
          '201': {
            description: 'Transfer completed successfully',
            headers: {
              'X-Idempotent-Replay': {
                schema: { type: 'boolean' },
                description: 'Set to true when the response is replayed from cache',
              },
            },
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/TransferResponse',
                },
              },
            },
          },
          '400': {
            description: 'Missing Idempotency-Key or validation error',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/ErrorResponse',
                },
              },
            },
          },
          '404': {
            description: 'One or both accounts not found',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/ErrorResponse',
                },
              },
            },
          },
          '409': {
            description: 'Request already in progress or idempotency key parameter mismatch',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/ErrorResponse',
                },
              },
            },
          },
          '422': {
            description: 'Insufficient funds in sender account',
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
    '/outbox': {
      get: {
        tags: ['Outbox'],
        summary: 'List transactional outbox events',
        description: 'Lists recent webhook delivery events recorded in the transactional outbox.',
        parameters: [
          {
            name: 'limit',
            in: 'query',
            description: 'Number of events to return (max 100)',
            schema: { type: 'integer', default: 50 },
          },
          {
            name: 'offset',
            in: 'query',
            description: 'Number of events to skip',
            schema: { type: 'integer', default: 0 },
          },
          {
            name: 'status',
            in: 'query',
            description: 'Filter by event delivery status',
            schema: {
              type: 'string',
              enum: ['PENDING', 'DELIVERED', 'DEAD_LETTER'],
            },
          },
        ],
        responses: {
          '200': {
            description: 'Outbox events retrieved successfully',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/OutboxListResponse',
                },
              },
            },
          },
        },
      },
    },
    '/outbox/{id}/replay': {
      post: {
        tags: ['Outbox'],
        summary: 'Replay dead-lettered outbox event',
        description: 'Resets a DEAD_LETTER outbox event back to PENDING with attempts reset to 0 for redelivery.',
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            description: 'UUID of the outbox event to replay',
            schema: { type: 'string', format: 'uuid' },
          },
        ],
        responses: {
          '200': {
            description: 'Event reset to PENDING successfully',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    message: { type: 'string' },
                    event: { $ref: '#/components/schemas/OutboxEvent' },
                  },
                },
              },
            },
          },
          '404': {
            description: 'Outbox event not found',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
        },
      },
    },
    '/mock-merchant/webhook': {
      post: {
        tags: ['Mock Merchant'],
        summary: 'Mock merchant webhook receiver',
        description: 'Receives signed webhook notifications, verifies HMAC-SHA256 signature, and simulates merchant crash mode.',
        parameters: [
          {
            name: 'X-LedgerFlow-Signature',
            in: 'header',
            required: true,
            description: 'HMAC signature header: t=<timestamp>,v1=<signature_hex>',
            schema: { type: 'string' },
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { type: 'object' },
            },
          },
        },
        responses: {
          '200': {
            description: 'Webhook successfully verified and received',
          },
          '401': {
            description: 'Invalid or missing HMAC signature',
          },
          '500': {
            description: 'Merchant server simulated crash mode',
          },
        },
      },
    },
    '/mock-merchant/crash': {
      post: {
        tags: ['Mock Merchant'],
        summary: 'Toggle merchant crash mode',
        description: 'Toggles or sets mock merchant crash mode (returning 500 when active).',
        requestBody: {
          required: false,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  crash: { type: 'boolean' },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Crash mode updated successfully',
          },
        },
      },
    },
    '/mock-merchant/status': {
      get: {
        tags: ['Mock Merchant'],
        summary: 'Get mock merchant status & history',
        description: 'Retrieves current crash mode state and list of received verified webhook payloads.',
        responses: {
          '200': {
            description: 'Merchant status and event history retrieved',
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
                  $ref: '#/components/schemas/LedgerEntry',
                },
              },
            },
          },
        ],
      },
      AccountLedgerResponse: {
        type: 'object',
        properties: {
          account_id: { type: 'string', format: 'uuid' },
          owner_name: { type: 'string' },
          currency: { type: 'string' },
          balance_paise: { type: 'integer' },
          created_at: { type: 'string', format: 'date-time' },
          ledger_entries: {
            type: 'array',
            items: {
              $ref: '#/components/schemas/LedgerEntry',
            },
          },
        },
      },
      LedgerEntry: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          transaction_id: { type: 'string', format: 'uuid' },
          account_id: { type: 'string', format: 'uuid' },
          entry_type: { type: 'string', enum: ['DEBIT', 'CREDIT'] },
          amount: { type: 'integer' },
          created_at: { type: 'string', format: 'date-time' },
        },
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
      CreateTransferRequest: {
        type: 'object',
        required: ['from_account_id', 'to_account_id', 'amount_paise'],
        properties: {
          from_account_id: {
            type: 'string',
            format: 'uuid',
            example: 'a0000000-0000-0000-0000-000000000001',
          },
          to_account_id: {
            type: 'string',
            format: 'uuid',
            example: 'a0000000-0000-0000-0000-000000000002',
          },
          amount_paise: {
            type: 'integer',
            minimum: 1,
            example: 25000,
            description: 'Amount in paise to transfer (25000 = ₹250.00)',
          },
          webhook_url: {
            type: 'string',
            format: 'uri',
            example: 'https://webhook.site/test-hook',
            description: 'Optional URL for async webhook notification via outbox',
          },
        },
      },
      TransferResponse: {
        type: 'object',
        properties: {
          transaction_id: { type: 'string', format: 'uuid' },
          from_account_id: { type: 'string', format: 'uuid' },
          to_account_id: { type: 'string', format: 'uuid' },
          amount_paise: { type: 'integer' },
          status: { type: 'string', example: 'COMPLETED' },
          webhook_url: { type: 'string', format: 'uri', nullable: true },
          outbox_event_id: { type: 'string', format: 'uuid', nullable: true },
          created_at: { type: 'string', format: 'date-time' },
        },
      },
      OutboxEvent: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          event_type: { type: 'string', example: 'transfer.completed' },
          payload: { type: 'object' },
          target_url: { type: 'string', format: 'uri' },
          status: {
            type: 'string',
            enum: ['PENDING', 'DELIVERED', 'DEAD_LETTER'],
          },
          attempts: { type: 'integer' },
          next_retry_at: { type: 'string', format: 'date-time', nullable: true },
          created_at: { type: 'string', format: 'date-time' },
        },
      },
      OutboxListResponse: {
        type: 'object',
        properties: {
          data: {
            type: 'array',
            items: { $ref: '#/components/schemas/OutboxEvent' },
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

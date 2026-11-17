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
    { name: 'Admin', description: 'Merchant and API key lifecycle administration' },
    { name: 'Accounts', description: 'Double-entry account management' },
    { name: 'Transfers', description: 'Idempotent double-entry fund transfers' },
    { name: 'Webhook Endpoints', description: 'Registered per-merchant webhook endpoints with SSRF protection' },
    { name: 'Outbox', description: 'Transactional outbox inspection and replay' },
    { name: 'Mock Merchant', description: 'Mock merchant receiver for webhook demos' },
  ],
  paths: {
    '/admin/merchants': {
      post: {
        tags: ['Admin'],
        summary: 'Bootstrap merchant and generate first API key',
        description: 'Creates a merchant tenant and generates its initial live API key. Protected by ADMIN_TOKEN.',
        security: [{ AdminAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/CreateMerchantRequest',
              },
            },
          },
        },
        responses: {
          '201': {
            description: 'Merchant and initial API key generated',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/CreateMerchantResponse',
                },
              },
            },
          },
          '401': {
            description: 'Missing or invalid admin bearer token',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
        },
      },
    },
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
        description: 'Retrieves accounts with current balances calculated from the double-entry ledger scoped to the authenticated merchant.',
        security: [{ ApiKeyAuth: [] }],
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
        security: [{ ApiKeyAuth: [] }],
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
        security: [{ ApiKeyAuth: [] }],
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
        security: [{ ApiKeyAuth: [] }],
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
        security: [{ ApiKeyAuth: [] }],
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
            description: 'Concurrent request already in progress with this idempotency key',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/ErrorResponse',
                },
              },
            },
          },
          '422': {
            description: 'Insufficient funds or idempotency key reused with different request payload',
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
    '/webhook-endpoints': {
      get: {
        tags: ['Webhook Endpoints'],
        summary: 'List registered webhook endpoints',
        description: 'Lists all webhook endpoints registered for the authenticated merchant with masked secrets.',
        security: [{ ApiKeyAuth: [] }],
        responses: {
          '200': {
            description: 'List of registered webhook endpoints',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/WebhookEndpointListResponse',
                },
              },
            },
          },
        },
      },
      post: {
        tags: ['Webhook Endpoints'],
        summary: 'Register new webhook endpoint with SSRF protection',
        description:
          'Registers a new webhook destination URL. Validates target URL against SSRF rules (rejecting loopback, private, link-local, metadata, and CGNAT ranges). Generates signing secret revealed strictly once.',
        security: [{ ApiKeyAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/CreateWebhookEndpointRequest',
              },
            },
          },
        },
        responses: {
          '201': {
            description: 'Webhook endpoint registered successfully',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/WebhookEndpointCreatedResponse',
                },
              },
            },
          },
          '400': {
            description: 'Validation error or SSRF violation',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
        },
      },
    },
    '/webhook-endpoints/{id}': {
      get: {
        tags: ['Webhook Endpoints'],
        summary: 'Get webhook endpoint with circuit breaker and rate limit state',
        description: 'Retrieves a single webhook endpoint with real-time circuit breaker status (CLOSED/OPEN/HALF_OPEN, consecutive failures, cooldown remaining) and token bucket rate limits.',
        security: [{ ApiKeyAuth: [] }],
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            description: 'UUID of the webhook endpoint',
            schema: { type: 'string', format: 'uuid' },
          },
        ],
        responses: {
          '200': {
            description: 'Webhook endpoint details retrieved successfully',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/WebhookEndpoint',
                },
              },
            },
          },
          '404': {
            description: 'Webhook endpoint not found',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
        },
      },
      delete: {
        tags: ['Webhook Endpoints'],
        summary: 'Delete webhook endpoint',
        description: 'Deletes a webhook endpoint owned by the authenticated merchant.',
        security: [{ ApiKeyAuth: [] }],
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            description: 'UUID of the webhook endpoint',
            schema: { type: 'string', format: 'uuid' },
          },
        ],
        responses: {
          '200': {
            description: 'Webhook endpoint deleted successfully',
          },
          '404': {
            description: 'Webhook endpoint not found',
          },
        },
      },
    },
    '/webhook-endpoints/{id}/rotate-secret': {
      post: {
        tags: ['Webhook Endpoints'],
        summary: 'Rotate webhook signing secret',
        description: 'Rotates the HMAC signing secret for a registered webhook endpoint. Revealed strictly once.',
        security: [{ ApiKeyAuth: [] }],
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            description: 'UUID of the webhook endpoint',
            schema: { type: 'string', format: 'uuid' },
          },
        ],
        responses: {
          '200': {
            description: 'Secret rotated successfully',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/WebhookEndpointCreatedResponse',
                },
              },
            },
          },
          '404': {
            description: 'Webhook endpoint not found',
          },
        },
      },
    },
    '/outbox': {
      get: {
        tags: ['Outbox'],
        summary: 'List transactional outbox events',
        description: 'Lists recent webhook delivery events recorded in the transactional outbox scoped to the authenticated merchant with filtering and cursor pagination.',
        security: [{ ApiKeyAuth: [] }],
        parameters: [
          {
            name: 'limit',
            in: 'query',
            description: 'Number of events to return (1-100, default 20)',
            schema: { type: 'integer', default: 20 },
          },
          {
            name: 'offset',
            in: 'query',
            description: 'Number of events to skip (offset pagination)',
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
          {
            name: 'endpoint_id',
            in: 'query',
            description: 'Filter by webhook endpoint UUID',
            schema: { type: 'string', format: 'uuid' },
          },
          {
            name: 'start_date',
            in: 'query',
            description: 'Filter events created on or after ISO date-time',
            schema: { type: 'string', format: 'date-time' },
          },
          {
            name: 'end_date',
            in: 'query',
            description: 'Filter events created on or before ISO date-time',
            schema: { type: 'string', format: 'date-time' },
          },
          {
            name: 'cursor',
            in: 'query',
            description: 'Base64url encoded cursor for cursor-based pagination',
            schema: { type: 'string' },
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
    '/outbox/replay-batch': {
      post: {
        tags: ['Outbox'],
        summary: 'Batch replay dead-lettered events for an endpoint',
        description: 'Finds all DEAD_LETTER outbox events belonging to the authenticated merchant for the specified endpoint_id, resets them to PENDING with attempts set to 0, and enqueues them for immediate delivery.',
        security: [{ ApiKeyAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['endpoint_id'],
                properties: {
                  endpoint_id: {
                    type: 'string',
                    format: 'uuid',
                    description: 'UUID of the webhook endpoint whose DEAD_LETTER events should be replayed',
                  },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Batch replay initiated successfully',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/BatchReplayResponse',
                },
              },
            },
          },
          '400': {
            description: 'Missing or invalid endpoint_id',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
          '404': {
            description: 'Webhook endpoint not found',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
        },
      },
    },
    '/outbox/{id}': {
      get: {
        tags: ['Outbox'],
        summary: 'Get outbox event with delivery attempt history',
        description: 'Retrieves a single outbox event and its full chronological delivery attempts including durations, HTTP statuses, and error snippets.',
        security: [{ ApiKeyAuth: [] }],
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            description: 'UUID of the outbox event',
            schema: { type: 'string', format: 'uuid' },
          },
        ],
        responses: {
          '200': {
            description: 'Outbox event details and attempt history retrieved successfully',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/OutboxEventDetail',
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
    '/outbox/{id}/replay': {
      post: {
        tags: ['Outbox'],
        summary: 'Replay outbox event',
        description: 'Resets a DEAD_LETTER or DELIVERED outbox event back to PENDING with attempts reset to 0 for redelivery, enqueuing it immediately while preserving full attempt history. Reuses stable event_id in payload so receivers can deduplicate. Rejects PENDING events with 400.',
        security: [{ ApiKeyAuth: [] }],
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
          '400': {
            description: 'Event is currently PENDING delivery',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
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
    securitySchemes: {
      ApiKeyAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'API Key (lf_live_...)',
        description: 'Merchant API Key (e.g. Bearer lf_live_...)',
      },
      AdminAuth: {
        type: 'http',
        scheme: 'bearer',
        description: 'Admin bootstrap token configured via ADMIN_TOKEN environment variable',
      },
    },
    schemas: {
      CreateMerchantRequest: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', example: 'Acme Payments' },
        },
      },
      CreateMerchantResponse: {
        type: 'object',
        properties: {
          merchant: {
            type: 'object',
            properties: {
              id: { type: 'string', format: 'uuid' },
              name: { type: 'string' },
              created_at: { type: 'string', format: 'date-time' },
            },
          },
          api_key: {
            type: 'object',
            properties: {
              id: { type: 'string', format: 'uuid' },
              key: {
                type: 'string',
                example: 'lf_live_a1b2c3d4...',
                description: 'Full plaintext API key. Displayed ONLY ONCE upon creation.',
              },
              key_prefix: { type: 'string', example: 'lf_live_a1b2' },
              created_at: { type: 'string', format: 'date-time' },
            },
          },
        },
      },
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
        },
      },
      CreateWebhookEndpointRequest: {
        type: 'object',
        required: ['url'],
        properties: {
          url: {
            type: 'string',
            format: 'uri',
            example: 'https://api.merchant.com/webhooks',
            description: 'Destination URL for webhooks. Validated against SSRF.',
          },
          event_types: {
            type: 'array',
            items: { type: 'string' },
            default: ['transfer.completed'],
            example: ['transfer.completed'],
          },
        },
      },
      CircuitBreakerStatus: {
        type: 'object',
        properties: {
          state: { type: 'string', enum: ['CLOSED', 'OPEN', 'HALF_OPEN'] },
          consecutive_failures: { type: 'integer' },
          opened_at: { type: 'string', format: 'date-time', nullable: true },
          last_failure_at: { type: 'string', format: 'date-time', nullable: true },
          cooldown_remaining_seconds: { type: 'integer' },
        },
      },
      RateLimitSettings: {
        type: 'object',
        properties: {
          deliveries_per_second: { type: 'integer' },
          burst: { type: 'integer' },
        },
      },
      WebhookEndpoint: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          merchant_id: { type: 'string', format: 'uuid' },
          url: { type: 'string', format: 'uri' },
          secret: { type: 'string', example: 'whsec_a1b2...c3d4' },
          event_types: { type: 'array', items: { type: 'string' } },
          status: { type: 'string', enum: ['ACTIVE', 'DISABLED'] },
          circuit_breaker: { $ref: '#/components/schemas/CircuitBreakerStatus' },
          rate_limit: { $ref: '#/components/schemas/RateLimitSettings' },
          created_at: { type: 'string', format: 'date-time' },
        },
      },
      WebhookEndpointCreatedResponse: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          merchant_id: { type: 'string', format: 'uuid' },
          url: { type: 'string', format: 'uri' },
          secret: {
            type: 'string',
            example: 'whsec_e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
            description: 'Full endpoint signing secret. Displayed ONLY ONCE upon creation or rotation.',
          },
          event_types: { type: 'array', items: { type: 'string' } },
          status: { type: 'string', enum: ['ACTIVE', 'DISABLED'] },
          created_at: { type: 'string', format: 'date-time' },
          warning: { type: 'string' },
        },
      },
      WebhookEndpointListResponse: {
        type: 'object',
        properties: {
          data: {
            type: 'array',
            items: { $ref: '#/components/schemas/WebhookEndpoint' },
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
          merchant_id: { type: 'string', format: 'uuid' },
          endpoint_id: { type: 'string', format: 'uuid', nullable: true },
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
      DeliveryAttempt: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          outbox_event_id: { type: 'string', format: 'uuid' },
          attempt_number: { type: 'integer' },
          started_at: { type: 'string', format: 'date-time' },
          duration_ms: { type: 'integer' },
          http_status: { type: 'integer', nullable: true },
          error_message: {
            type: 'string',
            nullable: true,
            description: 'Truncated error response body or network error snippet capped at 1KB',
          },
          request_signature: { type: 'string', nullable: true },
          next_retry_at: { type: 'string', format: 'date-time', nullable: true },
          created_at: { type: 'string', format: 'date-time' },
        },
      },
      OutboxEventDetail: {
        allOf: [
          { $ref: '#/components/schemas/OutboxEvent' },
          {
            type: 'object',
            properties: {
              delivery_attempts: {
                type: 'array',
                items: { $ref: '#/components/schemas/DeliveryAttempt' },
              },
            },
          },
        ],
      },
      BatchReplayResponse: {
        type: 'object',
        properties: {
          message: { type: 'string' },
          replayed_count: { type: 'integer' },
          event_ids: {
            type: 'array',
            items: { type: 'string', format: 'uuid' },
          },
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
              next_cursor: { type: 'string', nullable: true },
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

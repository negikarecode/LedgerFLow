import { z } from 'zod';

export const createWebhookEndpointSchema = z.object({
  url: z.string().url('A valid URL is required'),
  event_types: z.array(z.string()).min(1).default(['transfer.completed']),
});

export type CreateWebhookEndpointDto = z.infer<typeof createWebhookEndpointSchema>;

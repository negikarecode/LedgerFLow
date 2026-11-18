import { z } from 'zod';

export const createWebhookEndpointSchema = z.object({
  url: z
    .string()
    .max(2048, 'URL must not exceed 2048 characters')
    .url('A valid URL is required')
    .refine(
      (u) => u.startsWith('http://') || u.startsWith('https://'),
      'URL scheme must be http or https'
    ),
  event_types: z.array(z.string()).min(1).default(['transfer.completed']),
});

export type CreateWebhookEndpointDto = z.infer<typeof createWebhookEndpointSchema>;

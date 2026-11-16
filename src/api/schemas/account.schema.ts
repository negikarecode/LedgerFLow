import { z } from 'zod';
import { uuidSchema } from './common.schema';

export const createAccountSchema = z.object({
  owner_name: z
    .string()
    .trim()
    .min(1, { message: 'owner_name cannot be empty' })
    .max(255, { message: 'owner_name cannot exceed 255 characters' }),
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/, { message: 'currency must be a 3-letter ISO currency code (e.g., INR, USD)' })
    .default('INR'),
  initial_credit_paise: z
    .coerce
    .number()
    .int({ message: 'initial_credit_paise must be an integer' })
    .nonnegative({ message: 'initial_credit_paise must be greater than or equal to 0' })
    .default(0),
});

export const accountParamsSchema = z.object({
  id: uuidSchema,
});

export type CreateAccountInput = z.infer<typeof createAccountSchema>;

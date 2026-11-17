import { z } from 'zod';

export const createTransferSchema = z
  .object({
    from_account_id: z
      .string({ required_error: 'from_account_id is required' })
      .uuid({ message: 'from_account_id must be a valid UUID' }),
    to_account_id: z
      .string({ required_error: 'to_account_id is required' })
      .uuid({ message: 'to_account_id must be a valid UUID' }),
    amount_paise: z
      .number({ required_error: 'amount_paise is required' })
      .int({ message: 'amount_paise must be an integer' })
      .positive({ message: 'amount_paise must be greater than 0' }),
  })
  .refine((data) => data.from_account_id !== data.to_account_id, {
    message: 'from_account_id and to_account_id must not be the same',
    path: ['to_account_id'],
  });

export type CreateTransferInput = z.infer<typeof createTransferSchema>;

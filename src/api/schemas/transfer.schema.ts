import { z } from 'zod';

/**
 * Maximum safe monetary amount in paise representable accurately by IEEE 754 float
 * and JavaScript Number arithmetic: 2^53 - 1 = 9,007,199,254,740,991 paise (₹90,071,992,547,409.91).
 * Amounts beyond this threshold lose precision in JSON serialization and standard Number arithmetic.
 */
export const MAX_SAFE_PAISE = Number.MAX_SAFE_INTEGER; // 9,007,199,254,740,991
export const MIN_SAFE_PAISE = 1;

export const amountPaiseSchema = z
  .number({
    required_error: 'amount_paise is required',
    invalid_type_error: 'amount_paise must be a valid number',
  })
  .int({ message: 'amount_paise must be an integer' })
  .positive({ message: 'amount_paise must be greater than 0' })
  .max(MAX_SAFE_PAISE, {
    message: `amount_paise must not exceed ${MAX_SAFE_PAISE}`,
  })
  .refine((val) => Number.isSafeInteger(val), {
    message: 'amount_paise must be a safe JavaScript integer',
  });

export const createTransferSchema = z
  .preprocess(
    (raw: any) => {
      if (raw && typeof raw === 'object') {
        const from = raw.from_account_id ?? raw.source_account_id;
        const to = raw.to_account_id ?? raw.destination_account_id;
        return {
          ...raw,
          ...(from !== undefined
            ? { from_account_id: typeof from === 'string' ? from.trim() : from }
            : {}),
          ...(to !== undefined
            ? { to_account_id: typeof to === 'string' ? to.trim() : to }
            : {}),
        };
      }
      return raw;
    },
    z.object({
      from_account_id: z
        .string({ required_error: 'from_account_id is required' })
        .uuid({ message: 'from_account_id must be a valid UUID' }),
      to_account_id: z
        .string({ required_error: 'to_account_id is required' })
        .uuid({ message: 'to_account_id must be a valid UUID' }),
      amount_paise: amountPaiseSchema,
      source_account_id: z.string().uuid().optional(),
      destination_account_id: z.string().uuid().optional(),
    })
  )
  .refine(
    (data: any) => {
      const fromNormalized = data.from_account_id?.trim().toLowerCase();
      const toNormalized = data.to_account_id?.trim().toLowerCase();
      if (fromNormalized === toNormalized) return false;

      const sourceNorm =
        typeof data.source_account_id === 'string'
          ? data.source_account_id.trim().toLowerCase()
          : null;
      const destNorm =
        typeof data.destination_account_id === 'string'
          ? data.destination_account_id.trim().toLowerCase()
          : null;

      if (sourceNorm && (sourceNorm === toNormalized || sourceNorm === destNorm)) return false;
      if (destNorm && (destNorm === fromNormalized || destNorm === sourceNorm)) return false;

      return true;
    },
    {
      message: 'from_account_id and to_account_id must not be the same',
      path: ['to_account_id'],
    }
  );

export type CreateTransferInput = z.infer<typeof createTransferSchema>;

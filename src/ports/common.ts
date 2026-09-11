import { z } from 'zod';
import type { Millimes } from '@/lib/money';

/** A whole, safe-integer number of millimes. */
export const millimesSchema = z
  .number()
  .int()
  .transform((value) => (value === 0 ? 0 : value) as Millimes);

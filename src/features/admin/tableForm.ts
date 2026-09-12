/**
 * The admin's form for one table of the room, exactly as typed: a name, a place in the room and
 * whether the table is in service. Kept out of the component so its rules run without a DOM.
 */
import { z } from 'zod';
import { AppError } from '@/lib/errors';
import { diningTableInputSchema, type DiningTable, type DiningTableInput } from '@/ports';

/** The highest position the form takes: past any café's room, and far inside the column's integer. */
export const MAX_POSITION = 9_999;

const WHOLE_NUMBER = /^\d+$/;

export interface TableFormRules {
  /**
   * The names of the café's other tables, retired ones included. The server refuses a name one of
   * them has (VALIDATION_ERROR on the name), and the form says so before it is asked.
   */
  readonly takenNames: readonly string[];
  /**
   * True for a table that has an order open on it. Taking it out of service would take it off the
   * grid with the guests still sitting there and money owed, so the form keeps it in service until
   * the order is paid or cancelled.
   */
  readonly hasOpenOrder: boolean;
}

export function tableFormSchema({ takenNames, hasOpenOrder }: TableFormRules) {
  const taken = new Set(takenNames);
  return z.object({
    name: z.string().superRefine((value, ctx) => {
      const name = value.trim();
      if (name === '') {
        ctx.addIssue({ code: 'custom', message: 'A table needs a name' });
      } else if (taken.has(name)) {
        ctx.addIssue({ code: 'custom', message: `There is already a table called ${name}` });
      }
    }),
    position: z.string().superRefine((value, ctx) => {
      const trimmed = value.trim();
      if (!WHOLE_NUMBER.test(trimmed) || Number(trimmed) > MAX_POSITION) {
        ctx.addIssue({
          code: 'custom',
          message: `Enter a whole number from 0 to ${MAX_POSITION}`,
        });
      }
    }),
    isActive: z.boolean().superRefine((value, ctx) => {
      if (!value && hasOpenOrder) {
        ctx.addIssue({
          code: 'custom',
          message:
            'Guests are at this table: pay or cancel its order before taking it out of service',
        });
      }
    }),
  });
}

export type TableFormValues = z.infer<ReturnType<typeof tableFormSchema>>;

/** Where a new table goes: after the last one, in service. */
export function nextPosition(tables: readonly Pick<DiningTable, 'sortOrder'>[]): number {
  return tables.reduce((last, table) => Math.max(last, table.sortOrder), 0) + 1;
}

/** The form's starting values: `table` as it is, or a new table at the end of the room. */
export function tableFormValues(
  table: DiningTable | null,
  tables: readonly DiningTable[],
): TableFormValues {
  if (table === null) {
    return { name: '', position: String(nextPosition(tables)), isActive: true };
  }
  return { name: table.name, position: String(table.sortOrder), isActive: table.isActive };
}

/** The names `editing` (null for a new table) may not take: every other table's. */
export function takenNames(
  tables: readonly DiningTable[],
  editing: Pick<DiningTable, 'id'> | null,
): string[] {
  return tables.filter((table) => table.id !== editing?.id).map((table) => table.name);
}

/**
 * Valid form values as the orders port's input. Throws AppError VALIDATION_ERROR, with the Zod issues
 * in details, when the values are not ones the port takes.
 */
export function toDiningTableInput(values: TableFormValues): DiningTableInput {
  const position = values.position.trim();
  const input = diningTableInputSchema.safeParse({
    name: values.name,
    sortOrder: WHOLE_NUMBER.test(position) ? Number(position) : Number.NaN,
    isActive: values.isActive,
  });
  if (!input.success) {
    const { issues } = input.error;
    throw new AppError('VALIDATION_ERROR', issues[0]?.message ?? 'Invalid table', {
      details: { issues },
    });
  }
  return input.data;
}

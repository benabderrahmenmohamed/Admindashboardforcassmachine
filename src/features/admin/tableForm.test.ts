import { describe, expect, it } from 'vitest';
import { AppError } from '@/lib/errors';
import type { DiningTable } from '@/ports';
import {
  MAX_POSITION,
  nextPosition,
  tableFormSchema,
  tableFormValues,
  takenNames,
  toDiningTableInput,
  type TableFormRules,
  type TableFormValues,
} from './tableForm';

const ROOM: readonly DiningTable[] = [
  { id: 't1', name: 'Salle 1', sortOrder: 1, isActive: true },
  { id: 't2', name: 'Terrasse 1', sortOrder: 4, isActive: true },
  { id: 't3', name: 'Terrasse 4', sortOrder: 8, isActive: false },
];

const FREE: TableFormRules = { takenNames: [], hasOpenOrder: false };

function values(overrides: Partial<TableFormValues> = {}): TableFormValues {
  return { name: 'Salle 2', position: '2', isActive: true, ...overrides };
}

/** The messages the form shows under `field` for `form`, under `rules`. */
function errorsFor(
  field: keyof TableFormValues,
  form: Partial<TableFormValues>,
  rules: TableFormRules = FREE,
): string[] {
  const result = tableFormSchema(rules).safeParse(values(form));
  return result.success
    ? []
    : result.error.issues.filter((issue) => issue.path[0] === field).map((issue) => issue.message);
}

describe('the table form', () => {
  it('starts a new table after the last one of the room, in service', () => {
    expect(tableFormValues(null, ROOM)).toEqual({ name: '', position: '9', isActive: true });
    expect(nextPosition([])).toBe(1);
  });

  it('starts an existing table from what it is', () => {
    expect(tableFormValues(ROOM[2], ROOM)).toEqual({
      name: 'Terrasse 4',
      position: '8',
      isActive: false,
    });
  });

  it('needs a name, and not the name of another table, retired ones included', () => {
    const rules = { takenNames: takenNames(ROOM, ROOM[0]), hasOpenOrder: false };

    expect(errorsFor('name', { name: '   ' }, rules)).toEqual(['A table needs a name']);
    expect(errorsFor('name', { name: ' Terrasse 4 ' }, rules)).toEqual([
      'There is already a table called Terrasse 4',
    ]);
    // Its own name is not taken: saving a table without renaming it is not a clash.
    expect(errorsFor('name', { name: 'Salle 1' }, rules)).toEqual([]);
    expect(takenNames(ROOM, null)).toEqual(['Salle 1', 'Terrasse 1', 'Terrasse 4']);
  });

  it('takes a position from 0 up, as a whole number', () => {
    const message = `Enter a whole number from 0 to ${MAX_POSITION}`;

    for (const position of ['', '-1', '2.5', '1e3', 'deux', String(MAX_POSITION + 1)]) {
      expect(errorsFor('position', { position }), position).toEqual([message]);
    }
    for (const position of ['0', ' 7 ', String(MAX_POSITION)]) {
      expect(errorsFor('position', { position }), position).toEqual([]);
    }
  });

  it('keeps a table with guests at it in service', () => {
    const occupied = { takenNames: [], hasOpenOrder: true };

    expect(errorsFor('isActive', { isActive: false }, occupied)).toEqual([
      'Guests are at this table: pay or cancel its order before taking it out of service',
    ]);
    expect(errorsFor('isActive', { isActive: true }, occupied)).toEqual([]);
    expect(errorsFor('isActive', { isActive: false }, FREE)).toEqual([]);
  });

  it('turns valid values into what the orders port takes', () => {
    expect(toDiningTableInput(values({ name: '  Salle 9 ', position: ' 12 ' }))).toEqual({
      name: 'Salle 9',
      sortOrder: 12,
      isActive: true,
    });
  });

  it('refuses values the port would refuse, with a typed error', () => {
    expect(() => toDiningTableInput(values({ position: 'two' }))).toThrow(AppError);
    try {
      toDiningTableInput(values({ name: ' ' }));
      expect.unreachable('a table with no name was accepted');
    } catch (error) {
      expect(error).toMatchObject({ code: 'VALIDATION_ERROR', message: 'A table needs a name' });
    }
  });
});

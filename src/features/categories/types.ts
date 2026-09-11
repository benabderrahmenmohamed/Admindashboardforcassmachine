export type { Category, CategoryInput } from '@/ports';

/** A swatch offered by the category form: `name` is announced, `value` is stored. */
export interface CategoryColorOption {
  readonly name: string;
  readonly value: string;
}

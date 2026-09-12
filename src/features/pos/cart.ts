/**
 * The payment cart moved to `src/features/caisse/cart.ts`, where the spec puts it.
 *
 * This file is only the old name, kept while the adapters and the port contract suite still import
 * it (`src/adapters/**` and `src/ports/__contracts__/support.ts` belong to another unit this phase).
 * Nothing new should import it: when those imports move, delete this file.
 */
export * from '@/features/caisse/cart';

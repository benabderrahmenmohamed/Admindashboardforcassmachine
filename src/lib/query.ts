import { QueryClient } from '@tanstack/react-query';
import { errorClass, isAppError } from './errors';

export const queryKeys = {
  products: ['products'] as const,
  categories: ['categories'] as const,
  settings: ['settings'] as const,
};

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        refetchOnWindowFocus: false,
        // Retry only what can succeed later; a 403 or a validation error will not.
        retry: (failureCount, error) =>
          failureCount < 2 && isAppError(error) && errorClass(error.code) === 'retriable',
      },
      mutations: {
        retry: false,
      },
    },
  });
}

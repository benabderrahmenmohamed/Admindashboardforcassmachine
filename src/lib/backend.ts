import type { Backend } from '@/ports';
import { AppError } from './errors';
import { backendKind } from './env';

/**
 * Composition root: the only module that knows which adapter backs the ports. Adapters load
 * lazily, so a build only downloads the backend it actually runs on.
 */
export async function createBackend(): Promise<Backend> {
  const kind = backendKind();
  switch (kind) {
    case 'memory': {
      const { createMemoryBackend } = await import('@/adapters/memory');
      return createMemoryBackend();
    }
    case 'supabase': {
      const { createSupabaseBackend } = await import('@/adapters/supabase');
      return createSupabaseBackend();
    }
    case 'rest':
      throw new AppError('CONFIG_ERROR', 'The REST backend is not available yet.');
  }
}

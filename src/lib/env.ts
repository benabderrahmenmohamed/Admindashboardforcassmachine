import { AppError } from './errors';

export type BackendKind = 'memory' | 'supabase' | 'rest';

const BACKEND_KINDS: readonly string[] = ['memory', 'supabase', 'rest'];

function isBackendKind(value: string): value is BackendKind {
  return BACKEND_KINDS.includes(value);
}

/** The adapter the composition root builds, from VITE_BACKEND (default: supabase). */
export function backendKind(): BackendKind {
  const value = import.meta.env.VITE_BACKEND ?? 'supabase';
  if (!isBackendKind(value)) {
    throw new AppError(
      'CONFIG_ERROR',
      `VITE_BACKEND must be memory, supabase or rest; got "${value}".`,
    );
  }
  return value;
}

function required(name: string, value: string | undefined): string {
  if (!value) {
    throw new AppError(
      'CONFIG_ERROR',
      `Missing ${name}: copy .env.example to .env and fill it in.`,
    );
  }
  return value;
}

export function supabaseEnv(): { url: string; anonKey: string } {
  return {
    url: required('VITE_SUPABASE_URL', import.meta.env.VITE_SUPABASE_URL).replace(/\/+$/, ''),
    anonKey: required('VITE_SUPABASE_ANON_KEY', import.meta.env.VITE_SUPABASE_ANON_KEY),
  };
}

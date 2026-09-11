import { createContext, useContext, type ReactNode } from 'react';
import type { Backend } from '@/ports';
import { AppError } from './errors';

const BackendContext = createContext<Backend | null>(null);

export function BackendProvider({ backend, children }: { backend: Backend; children: ReactNode }) {
  return <BackendContext.Provider value={backend}>{children}</BackendContext.Provider>;
}

/** The ports for the running backend. Components and hooks never import an adapter directly. */
export function useBackend(): Backend {
  const backend = useContext(BackendContext);
  if (!backend) {
    throw new AppError('CONFIG_ERROR', 'useBackend must be used inside BackendProvider');
  }
  return backend;
}

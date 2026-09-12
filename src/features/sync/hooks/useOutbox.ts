import { useContext, useSyncExternalStore } from 'react';
import { AppError } from '@/lib/errors';
import type { OutboxRuntime, OutboxSnapshot } from '../runtime';
import type { OutboxRecord, OutboxSummary } from '../types';
import { OutboxContext } from './outboxContext';

/**
 * This device's queue: the outbox to append to, the storage its registration lives in, and a way to
 * ask for a drain pass. Inside OutboxProvider it is always there, because the provider shows a
 * spinner until the queue is open and an error when it cannot be.
 */
export function useOutbox(): OutboxRuntime {
  const runtime = useContext(OutboxContext);
  if (!runtime) {
    throw new AppError('CONFIG_ERROR', 'useOutbox must be used inside OutboxProvider');
  }
  return runtime;
}

/** The queue as it stands now; the caller re-renders whenever any of it changes. */
export function useOutboxSnapshot(): OutboxSnapshot {
  const runtime = useOutbox();
  return useSyncExternalStore(runtime.subscribe, runtime.snapshot);
}

/** How much is waiting, how much is stuck, and when the server last took something. */
export function useOutboxSummary(): OutboxSummary {
  return useOutboxSnapshot().summary;
}

/** Every record this device has written, in the order they go out. */
export function useOutboxRecords(): readonly OutboxRecord[] {
  return useOutboxSnapshot().records;
}

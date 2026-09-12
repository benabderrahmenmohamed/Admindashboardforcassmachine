import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ErrorState, FullPageLoading } from '@/components/feedback';
import { useAuth } from '@/features/auth/hooks/useAuth';
import { useBackend } from '@/lib/backend-context';
import { toAppError, type AppError } from '@/lib/errors';
import { queryKeys } from '@/lib/query';
import { OutboxContext } from '../hooks/outboxContext';
import { startOutboxRuntime, type OutboxRuntime } from '../runtime';

/**
 * Opens this device's queue and keeps it draining while the app is up. Everything under it can
 * write records without waiting for the network; without it, neither the register nor the terminal
 * registration has anywhere to put them, so the app says so rather than pretending to work.
 */
export function OutboxProvider({ children }: { children: ReactNode }) {
  const backend = useBackend();
  const { state } = useAuth();
  const queryClient = useQueryClient();
  const [runtime, setRuntime] = useState<OutboxRuntime | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  // Read on every attempt: records are sent only while this device holds a live session.
  const canSend = useRef(false);

  useEffect(() => {
    let stopped = false;
    let started: OutboxRuntime | null = null;
    startOutboxRuntime({ backend, canSend: () => canSend.current }).then(
      (next) => {
        started = next;
        if (stopped) {
          next.stop();
        } else {
          setRuntime(next);
        }
      },
      (cause: unknown) => {
        console.error('The queue on this device could not be opened', cause);
        if (!stopped) {
          setError(toAppError(cause));
        }
      },
    );
    return () => {
      stopped = true;
      started?.stop();
    };
  }, [backend]);

  // A new auth state is a sign-in, a sign-out or a refreshed token: each is a reason to try again.
  useEffect(() => {
    canSend.current = state.status === 'authenticated';
    if (canSend.current) {
      runtime?.drain();
    }
  }, [runtime, state]);

  // What the server takes changes stock, the sales list and the running report. Nothing else
  // invalidates them any more: records reach the server from the queue, not from a screen.
  useEffect(() => {
    if (!runtime) {
      return;
    }
    let lastAckAt = runtime.snapshot().summary.lastAckAt;
    return runtime.subscribe(() => {
      const { summary, state: sync } = runtime.snapshot();
      // Once the pass is over, so a burst that drains fifty records reloads the lists once.
      if (sync.kind === 'sending' || summary.lastAckAt === lastAckAt) {
        return;
      }
      lastAckAt = summary.lastAckAt;
      void queryClient.invalidateQueries({ queryKey: queryKeys.products });
      void queryClient.invalidateQueries({ queryKey: queryKeys.sales });
      void queryClient.invalidateQueries({ queryKey: queryKeys.sessions });
    });
  }, [queryClient, runtime]);

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <ErrorState
          title="This device cannot keep its sales"
          error={error}
          onRetry={() => window.location.reload()}
        />
      </div>
    );
  }
  if (!runtime) {
    return <FullPageLoading />;
  }
  return <OutboxContext.Provider value={runtime}>{children}</OutboxContext.Provider>;
}

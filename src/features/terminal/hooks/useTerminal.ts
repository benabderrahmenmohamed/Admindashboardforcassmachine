import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { useOutbox } from '@/features/sync/hooks/useOutbox';
import type { TerminalMeta } from '@/features/sync/types';
import { useBackend } from '@/lib/backend-context';
import { queryKeys } from '@/lib/query';
import {
  assertCanRegister,
  migrateLegacyTerminal,
  readRegistration,
  registerTerminal,
} from '../terminalStore';

/**
 * This device's registration. It is not a server query — it is read from the outbox beside the
 * records — so its key lives here rather than in src/lib/query.ts.
 */
export const terminalRegistrationKey = ['terminal', 'registration'] as const;

/**
 * This device's registration and receipt counter, or null when it is not a terminal. A device
 * coming from Phase 3 is moved out of local storage on the first read.
 */
export function useDeviceTerminal(): UseQueryResult<TerminalMeta | null> {
  const runtime = useOutbox();
  return useQuery({
    queryKey: terminalRegistrationKey,
    queryFn: async () => {
      const moved = await migrateLegacyTerminal(runtime.storage, Date.now());
      if (moved.record) {
        // The record came in behind the outbox's back, so nothing would send it until the next
        // interval tick; a device upgrading from Phase 3 gets its one unsent record away now.
        runtime.drain();
      }
      return await readRegistration(runtime.storage);
    },
  });
}

/**
 * Admin only: registers this device as terminal `code`. The device adopts the server's epoch and
 * receipt counter, and the terminal's open session if it has one.
 */
export function useRegisterTerminal() {
  const { terminals } = useBackend();
  // Kept whole rather than destructured: `drain` is a method of the runtime, like a port's.
  const runtime = useOutbox();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (code: string) => {
      // Checked before the server bumps the epoch, so a queued record is never stranded under the
      // registration it was written for.
      await assertCanRegister(runtime.storage);
      const registration = await terminals.register(code);
      await registerTerminal(runtime.storage, registration, Date.now());
      return registration;
    },
    onSuccess: (registration) => {
      queryClient.setQueryData(
        queryKeys.currentSession(registration.terminalId),
        registration.openSession,
      );
      void queryClient.invalidateQueries({ queryKey: terminalRegistrationKey });
      // The registration is written straight to the storage, which the outbox does not hear about,
      // so a queue paused for want of one would go on saying so until its next pass on its own.
      runtime.drain();
    },
  });
}

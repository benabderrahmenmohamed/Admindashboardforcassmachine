import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import { useBackend } from '@/lib/backend-context';
import { queryKeys } from '@/lib/query';
import { deviceTerminal, type TerminalSnapshot } from '../terminalStore';

/** This device's registration and unsent record; re-renders when either changes, in any tab. */
export function useDeviceTerminal(): TerminalSnapshot {
  const store = deviceTerminal();
  return useSyncExternalStore(store.subscribe, store.snapshot);
}

/**
 * Admin only: registers this device as terminal `code`. The device adopts the server's epoch and
 * receipt counter, and the terminal's open session if it has one.
 */
export function useRegisterTerminal() {
  const { terminals } = useBackend();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (code: string) => {
      const store = deviceTerminal();
      // Checked before the server bumps the epoch, so an unsent record is never stranded.
      store.assertCanRegister();
      const registration = await terminals.register(code);
      store.register({
        terminalId: registration.terminalId,
        code: registration.code,
        epoch: registration.epoch,
        lastSeq: registration.lastSeq,
        registeredAt: new Date().toISOString(),
      });
      return registration;
    },
    onSuccess: (registration) => {
      queryClient.setQueryData(
        queryKeys.currentSession(registration.terminalId),
        registration.openSession,
      );
    },
  });
}

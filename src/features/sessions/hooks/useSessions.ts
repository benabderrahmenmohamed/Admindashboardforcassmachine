import { skipToken, useQuery } from '@tanstack/react-query';
import { useBackend } from '@/lib/backend-context';
import { queryKeys } from '@/lib/query';

/**
 * The open session of a terminal, or null when it has none. Pass null while no terminal is known.
 *
 * Opening and closing a session are not here: they are records this device writes, so they go
 * through the outbox (src/features/pos/hooks/useRegister.ts) and never straight to a port.
 */
export function useCurrentSession(terminalId: string | null) {
  const { sessions } = useBackend();
  return useQuery({
    queryKey: queryKeys.currentSession(terminalId ?? ''),
    queryFn: terminalId === null ? skipToken : () => sessions.current(terminalId),
  });
}

import { skipToken, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useBackend } from '@/lib/backend-context';
import { queryKeys } from '@/lib/query';
import type { CloseSessionRecord, OpenSessionRecord } from '@/ports';

/** The open session of a terminal, or null when it has none. Pass null while no terminal is known. */
export function useCurrentSession(terminalId: string | null) {
  const { sessions } = useBackend();
  return useQuery({
    queryKey: queryKeys.currentSession(terminalId ?? ''),
    queryFn: terminalId === null ? skipToken : () => sessions.current(terminalId),
  });
}

/** The stored report of a closed session, or the running report of an open one. */
export function useZReport(sessionId: string | null) {
  const { sessions } = useBackend();
  return useQuery({
    queryKey: queryKeys.zReport(sessionId ?? ''),
    queryFn: sessionId === null ? skipToken : () => sessions.zReport(sessionId),
  });
}

/** Opens a session from a record built with src/features/sessions/records.ts. Safe to resend. */
export function useOpenSession() {
  const { sessions } = useBackend();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (record: OpenSessionRecord) => sessions.open(record),
    onSuccess: (result) => {
      queryClient.setQueryData(queryKeys.currentSession(result.session.terminalId), result.session);
    },
  });
}

/** Closes a session; the result carries the server's Z-report. Safe to resend. */
export function useCloseSession() {
  const { sessions } = useBackend();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (record: CloseSessionRecord) => sessions.close(record),
    // Not awaited: the close is stored; the session and sales views refresh in the background.
    onSuccess: (result) => {
      queryClient.setQueryData(queryKeys.zReport(result.sessionId), result.zReport);
      void queryClient.invalidateQueries({ queryKey: queryKeys.sessions });
      void queryClient.invalidateQueries({ queryKey: queryKeys.sales });
    },
  });
}

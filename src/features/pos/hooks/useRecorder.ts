import { useState, useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import { useRecordSale } from '@/features/sales/hooks/useRecordSale';
import { useCloseSession, useOpenSession } from '@/features/sessions/hooks/useSessions';
import { deviceTerminal, type PendingRecord } from '@/features/terminal/terminalStore';
import { errorMessage } from '@/lib/errors';
import {
  createRecorder,
  type RecordAttempt,
  type RecorderState,
  type RecordingPorts,
  type RecordOutcome,
} from '../recording';

export interface RecorderHandle {
  readonly state: RecorderState;
  /**
   * Builds a record and sends it. Resolves to the outcome, or to null when nothing was recorded: a
   * record that could not be built or stored is reported with a toast, and a record kept pending is
   * shown with its error on the unsent-record card.
   */
  readonly record: (build: () => Promise<PendingRecord>) => Promise<RecordOutcome | null>;
  /** Resends the pending record exactly as it was written. */
  readonly retry: () => Promise<RecordOutcome | null>;
  /** Gives up on a pending record the server refused. */
  readonly discard: () => void;
}

/** Sends this device's records through the sales and sessions hooks; `onRecorded` hears each answer. */
export function useRecorder(onRecorded: (outcome: RecordOutcome) => void): RecorderHandle {
  const [recorder] = useState(() => createRecorder(deviceTerminal()));
  const state = useSyncExternalStore(recorder.subscribe, recorder.snapshot);
  const recordSale = useRecordSale();
  const openSession = useOpenSession();
  const closeSession = useCloseSession();
  const ports: RecordingPorts = {
    recordSale: (record) => recordSale.mutateAsync(record),
    openSession: (record) => openSession.mutateAsync(record),
    closeSession: (record) => closeSession.mutateAsync(record),
  };

  const settle = (attempt: RecordAttempt): RecordOutcome | null => {
    if (attempt.ok) {
      onRecorded(attempt.outcome);
      return attempt.outcome;
    }
    if (!attempt.kept) {
      toast.error(errorMessage(attempt.error, 'The record could not be sent'));
    }
    return null;
  };

  return {
    state,
    record: async (build) => {
      let pending: PendingRecord;
      try {
        pending = await build();
      } catch (error) {
        toast.error(errorMessage(error, 'The record could not be prepared'));
        return null;
      }
      return settle(await recorder.send(pending, ports));
    },
    retry: async () => settle(await recorder.retry(ports)),
    discard: recorder.discard,
  };
}

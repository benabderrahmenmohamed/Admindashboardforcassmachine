import { MonitorX } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { ErrorState, LoadingState } from '@/components/feedback';
import { useCurrentUser } from '@/features/auth/hooks/useAuth';
import { OpenSessionCard } from '@/features/sessions/components/OpenSessionCard';
import {
  ZReportDialog,
  type ClosedSessionReport,
} from '@/features/sessions/components/ZReportDialog';
import { useCurrentSession } from '@/features/sessions/hooks/useSessions';
import { buildOpenSessionRecord } from '@/features/sessions/records';
import { useDeviceTerminal } from '@/features/terminal/hooks/useTerminal';
import type { PendingRecord, StoredTerminal } from '@/features/terminal/terminalStore';
import type { Millimes } from '@/lib/money';
import { emptyCart } from '../cart';
import { posGate } from '../gate';
import { useRecorder } from '../hooks/useRecorder';
import {
  discardQuestion,
  newRecordId,
  recordedMessage,
  terminalContext,
  type RecordOutcome,
} from '../recording';
import type { Cart } from '../types';
import { PendingRecordCard } from './PendingRecordCard';
import { RegisterScreen } from './RegisterScreen';

/**
 * The register. Nothing is recorded until this device is a registered terminal with an open
 * session and no unsent record (see posGate).
 */
export function PosPage() {
  const user = useCurrentUser();
  const { terminal, pending } = useDeviceTerminal();
  // Kept here rather than in the selling screen, so a sale whose send was refused and then
  // discarded is still in the cart to try again.
  const [cart, setCart] = useState<Cart>(emptyCart);
  const [report, setReport] = useState<ClosedSessionReport | null>(null);
  const [isReportOpen, setIsReportOpen] = useState(false);

  const recorder = useRecorder((outcome: RecordOutcome) => {
    const message = recordedMessage(outcome);
    if (outcome.type === 'sale' && outcome.result.status === 'voided') {
      toast.warning(message);
      return;
    }
    toast.success(message);
    if (outcome.type === 'sale' && outcome.record.kind === 'sale') {
      setCart(emptyCart);
    }
    if (outcome.type === 'session_close') {
      setReport({ server: outcome.result.zReport, local: outcome.record.clientZReport });
      setIsReportOpen(true);
    }
  });
  const sessionQuery = useCurrentSession(terminal?.terminalId ?? null);

  const gate = posGate({
    terminal,
    pending,
    firstSendId:
      recorder.state.status === 'sending' && recorder.state.first ? recorder.state.id : null,
    session: sessionQuery.data,
    sessionError: sessionQuery.isFetching ? null : sessionQuery.error,
  });

  const openSession = (registered: StoredTerminal, openingFloatMillimes: Millimes) => {
    void recorder.record(async () => ({
      type: 'session_open',
      record: await buildOpenSessionRecord({
        id: newRecordId(),
        terminal: terminalContext(registered),
        actorUserId: user.id,
        openedAt: new Date().toISOString(),
        openingFloatMillimes,
      }),
    }));
  };

  const discard = (refused: PendingRecord) => {
    if (!confirm(discardQuestion(refused))) return;
    recorder.discard();
    // A refusal can mean the session changed on the server (closed, or opened elsewhere).
    if (terminal) {
      void sessionQuery.refetch();
    }
  };

  const content = (): ReactNode => {
    switch (gate.kind) {
      case 'pending':
        return (
          <PendingRecordCard
            pending={gate.pending}
            state={recorder.state}
            onRetry={() => void recorder.retry()}
            onDiscard={() => discard(gate.pending)}
          />
        );
      case 'unregistered':
        return <TerminalNotRegistered />;
      case 'loading':
        return <LoadingState />;
      case 'error':
        return (
          <ErrorState
            title="Failed to load the session"
            error={gate.error}
            onRetry={() => void sessionQuery.refetch()}
          />
        );
      case 'closed':
        return (
          <OpenSessionCard
            terminalCode={gate.terminal.code}
            isOpening={recorder.state.status === 'sending'}
            onOpen={(amount) => openSession(gate.terminal, amount)}
          />
        );
      case 'open':
        return (
          <RegisterScreen
            terminal={gate.terminal}
            session={gate.session}
            actorUserId={user.id}
            recorder={recorder}
            cart={cart}
            onCartChange={setCart}
          />
        );
    }
  };

  return (
    <div className="max-w-[1600px] mx-auto">
      {content()}
      <ZReportDialog report={report} open={isReportOpen} onOpenChange={setIsReportOpen} />
    </div>
  );
}

function TerminalNotRegistered() {
  return (
    <div className="flex flex-col items-center justify-center h-64 text-center px-4" role="alert">
      <MonitorX className="w-12 h-12 text-gray-400 mb-4" />
      <p className="font-semibold text-gray-900 mb-1">
        This device is not registered as a terminal
      </p>
      <p className="text-sm text-gray-600 max-w-md">
        Sales can only be recorded on a registered terminal. Ask an admin to register this device in
        Settings, then open a session here.
      </p>
    </div>
  );
}

import { MonitorX, ShieldAlert, Users } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { ErrorState, LoadingState } from '@/components/feedback';
import { useCurrentUser } from '@/features/auth/hooks/useAuth';
import { OpenSessionCard } from '@/features/sessions/components/OpenSessionCard';
import { ZReportDialog } from '@/features/sessions/components/ZReportDialog';
import { useCurrentSession } from '@/features/sessions/hooks/useSessions';
import { useOutboxRecords } from '@/features/sync/hooks/useOutbox';
import { useDeviceTerminal } from '@/features/terminal/hooks/useTerminal';
import { emptyCart } from '../cart';
import { posGate } from '../gate';
import { useRegister } from '../hooks/useRegister';
import { useTerminalLock } from '../hooks/useTerminalLock';
import { findRecord, isSessionClose, waitingBehind } from '../queue';
import type { Cart } from '../types';
import { QueueBlockedCard } from './QueueBlockedCard';
import { RegisterScreen } from './RegisterScreen';

/**
 * The register. Records go into this device's queue and the screen carries on: the only things that
 * stop it are a device that is not a terminal, a second tab holding the same one, and a record the
 * server refused, which would take the receipt numbers behind it down with it (see posGate).
 */
export function PosPage() {
  const user = useCurrentUser();
  const terminalQuery = useDeviceTerminal();
  const records = useOutboxRecords();
  const register = useRegister(user.id);
  const terminal = terminalQuery.data;
  const lock = useTerminalLock(terminal?.code ?? null);
  const sessionQuery = useCurrentSession(terminal?.terminalId ?? null);
  // Kept here rather than in the selling screen, so a sale that could not be written is still in
  // the cart to try again.
  const [cart, setCart] = useState<Cart>(emptyCart);
  const [closeId, setCloseId] = useState<string | null>(null);
  const [isReportOpen, setIsReportOpen] = useState(false);
  const closed = findRecord(records, closeId);

  const gate = posGate({
    secureContext: globalThis.isSecureContext,
    terminal,
    lock,
    records,
    session: sessionQuery.data,
    sessionError: sessionQuery.isFetching ? null : sessionQuery.error,
  });

  const content = (): ReactNode => {
    if (terminalQuery.isError) {
      return (
        <ErrorState
          title="Failed to read this device's registration"
          error={terminalQuery.error}
          onRetry={() => void terminalQuery.refetch()}
        />
      );
    }
    switch (gate.kind) {
      case 'insecure':
        return <InsecureContext />;
      case 'unregistered':
        return <TerminalNotRegistered />;
      case 'locked':
        return <TerminalLocked reason={gate.reason} />;
      case 'blocked':
        return (
          <QueueBlockedCard
            record={gate.record}
            waiting={waitingBehind(records, gate.record).length}
          />
        );
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
            isOpening={register.isWriting}
            onOpen={(amount) => void register.openSession(amount)}
          />
        );
      case 'open':
        return (
          <RegisterScreen
            terminal={gate.terminal}
            session={gate.session}
            records={records}
            register={register}
            cart={cart}
            onCartChange={setCart}
            onClosed={(record) => {
              setCloseId(record.id);
              setIsReportOpen(true);
            }}
          />
        );
    }
  };

  return (
    <div className="max-w-[1600px] mx-auto">
      {content()}
      <ZReportDialog
        record={closed && isSessionClose(closed) ? closed : null}
        open={isReportOpen}
        onOpenChange={setIsReportOpen}
      />
    </div>
  );
}

function Blocked({
  icon,
  title,
  children,
}: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center h-64 text-center px-4" role="alert">
      {icon}
      <p className="font-semibold text-gray-900 mb-1">{title}</p>
      <p className="text-sm text-gray-600 max-w-md">{children}</p>
    </div>
  );
}

function TerminalNotRegistered() {
  return (
    <Blocked
      icon={<MonitorX className="w-12 h-12 text-gray-400 mb-4" />}
      title="This device is not registered as a terminal"
    >
      Sales can only be recorded on a registered terminal. Ask an admin to register this device in
      Settings, then open a session here.
    </Blocked>
  );
}

function TerminalLocked({ reason }: { readonly reason: 'taken' | 'unavailable' }) {
  return (
    <Blocked
      icon={<Users className="w-12 h-12 text-gray-400 mb-4" />}
      title={
        reason === 'taken'
          ? 'This register is already open in another tab or window'
          : 'This browser cannot keep the register to one tab'
      }
    >
      {reason === 'taken'
        ? 'Receipt numbers are handed out by one window at a time, so they never repeat. Close the other one, or carry on selling there.'
        : 'The register needs the Web Locks API to make sure only one window numbers receipts. Open it over https in an up-to-date browser.'}
    </Blocked>
  );
}

function InsecureContext() {
  return (
    <Blocked
      icon={<ShieldAlert className="w-12 h-12 text-gray-400 mb-4" />}
      title="This page is not served securely"
    >
      The register signs and queues every sale on the device, which the browser only allows over
      https or on localhost. Open it at its https address.
    </Blocked>
  );
}

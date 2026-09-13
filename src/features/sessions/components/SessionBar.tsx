import { Lock, Monitor, Receipt } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { formatTND } from '@/lib/money';
import type { CashSession } from '@/ports';

interface SessionBarProps {
  readonly terminalCode: string;
  readonly session: CashSession;
  /** True while a record is being written to this device: closing waits for it. */
  readonly isRecording: boolean;
  readonly onShowSales: () => void;
  readonly onCloseSession: () => void;
}

export function SessionBar({
  terminalCode,
  session,
  isRecording,
  onShowSales,
  onCloseSession,
}: SessionBarProps) {
  return (
    <Card className="mb-4">
      <CardContent className="px-4 py-3 [&:last-child]:pb-3 flex flex-wrap items-center justify-between gap-3">
        <dl className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
          {/* A list of terms holds only terms and definitions, so the icon goes inside the term. */}
          <div className="flex items-center gap-2">
            <dt className="flex items-center gap-2 text-gray-500">
              <Monitor className="w-4 h-4" aria-hidden="true" />
              Terminal
            </dt>
            <dd className="font-semibold text-gray-900">{terminalCode}</dd>
          </div>
          <div className="flex items-center gap-2">
            <dt className="text-gray-500">Opened</dt>
            <dd className="font-semibold text-gray-900">
              {new Date(session.openedAt).toLocaleString()}
            </dd>
          </div>
          <div className="flex items-center gap-2">
            <dt className="text-gray-500">Float</dt>
            <dd className="font-semibold text-gray-900">
              {formatTND(session.openingFloatMillimes)}
            </dd>
          </div>
        </dl>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => onShowSales()}>
            <Receipt className="mr-2 h-4 w-4" />
            Sales
          </Button>
          <Button variant="outline" disabled={isRecording} onClick={() => onCloseSession()}>
            <Lock className="mr-2 h-4 w-4" />
            Close session
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

import { TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { syncStatus, type SessionCloseRecord } from '@/features/pos/queue';
import { syncStatusMessage } from '@/features/pos/recording';
import { SyncBadge } from '@/features/sales/components/SyncBadge';
import { sameZReport } from '@/features/sessions/zReport';
import type { ZReport } from '@/ports';
import { varianceTone, zReportRows, type VarianceTone } from './zReportView';

const VARIANCE_STYLES: Record<VarianceTone, { readonly row: string; readonly note: string }> = {
  short: { row: 'bg-red-50 text-red-700', note: 'short' },
  over: { row: 'bg-amber-50 text-amber-800', note: 'over' },
  even: { row: 'bg-green-50 text-green-700', note: 'balanced' },
  unknown: { row: 'bg-gray-100 text-gray-700', note: 'not counted' },
};

interface ZReportDialogProps {
  /** The close as the queue holds it. Kept after the dialog closes, so it does not empty as it fades. */
  readonly record: SessionCloseRecord | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

/**
 * The Z-report of a session that was just closed. This device's own calculation is on screen at
 * once, from the records it wrote; the server's report replaces it, with every figure that differs
 * underneath, as soon as the close reaches the server.
 */
export function ZReportDialog({ record, open, onOpenChange }: ZReportDialogProps) {
  return (
    <Dialog open={open && record !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            Z-report
            {record && <SyncBadge status={syncStatus(record)} />}
          </DialogTitle>
          <DialogDescription>
            {record
              ? `The session is closed. ${syncStatusMessage(record)}`
              : 'No session was closed here yet.'}
          </DialogDescription>
        </DialogHeader>
        {record && <ZReportBody record={record} />}
        <Button className="w-full" onClick={() => onOpenChange(false)}>
          Done
        </Button>
      </DialogContent>
    </Dialog>
  );
}

function ZReportBody({ record }: { readonly record: SessionCloseRecord }) {
  const local = record.payload.clientZReport;
  const server = record.result?.zReport ?? null;
  // The server's report is the one kept; this device's stands in until it arrives.
  const shown = server ?? local;

  if (!shown) {
    return (
      <p className="text-sm text-gray-500">
        This device did not open this session, so it could not count it. The report appears here
        once the close reaches the server.
      </p>
    );
  }
  return (
    <div className="space-y-4">
      <ReportNote server={server} local={local} />
      <ZReportFigures report={shown} local={server ? local : null} />
    </div>
  );
}

function ReportNote({
  server,
  local,
}: {
  readonly server: ZReport | null;
  readonly local: ZReport | null;
}) {
  if (!server) {
    return (
      <p className="text-sm text-gray-500">
        Counted on this device from the records of the session. The server&apos;s own report
        replaces it once the close reaches it.
      </p>
    );
  }
  if (local === null) {
    return (
      <p className="text-sm text-gray-500">
        This device could not count the session itself, so the report was not checked against its
        own calculation.
      </p>
    );
  }
  if (sameZReport(server, local)) {
    return null;
  }
  return (
    <div
      role="alert"
      className="flex gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800"
    >
      <TriangleAlert className="h-4 w-4 shrink-0 mt-0.5" />
      <p>
        <span className="font-semibold">Discrepancy:</span> this device calculated different
        figures, shown under the recorded ones. The report recorded by the server is the one kept.
      </p>
    </div>
  );
}

function ZReportFigures({
  report,
  local,
}: {
  readonly report: ZReport;
  readonly local: ZReport | null;
}) {
  const rows = zReportRows(report, local);
  const variance = VARIANCE_STYLES[varianceTone(report.varianceMillimes)];
  const sections = [...new Set(rows.map((row) => row.section))];

  return (
    <>
      {sections.map((section) => (
        <div key={section}>
          <p className="text-xs font-semibold uppercase text-gray-500 mb-1">{section}</p>
          <dl className="divide-y rounded-lg border">
            {rows
              .filter((row) => row.section === section)
              .map((row) => (
                <div
                  key={row.label}
                  className={`flex items-start justify-between gap-4 px-3 py-2 text-sm ${
                    row.isVariance ? `${variance.row} font-semibold` : ''
                  }`}
                >
                  <dt>
                    {row.label}
                    {row.isVariance && (
                      <span className="ml-2 text-xs font-normal">({variance.note})</span>
                    )}
                  </dt>
                  <dd className="text-right">
                    {row.value}
                    {row.localValue !== null && (
                      <span className="block text-xs font-normal text-amber-700">
                        This device: {row.localValue}
                      </span>
                    )}
                  </dd>
                </div>
              ))}
          </dl>
        </div>
      ))}
    </>
  );
}

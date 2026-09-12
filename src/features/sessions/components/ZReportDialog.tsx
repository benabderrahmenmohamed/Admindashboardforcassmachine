import { TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { sameZReport } from '@/features/sessions/zReport';
import type { ZReport } from '@/ports';
import { varianceTone, zReportRows, type VarianceTone } from './zReportView';

/** A closed session's report as the server stored it, and this device's own calculation. */
export interface ClosedSessionReport {
  readonly server: ZReport;
  readonly local: ZReport | null;
}

const VARIANCE_STYLES: Record<VarianceTone, { readonly row: string; readonly note: string }> = {
  short: { row: 'bg-red-50 text-red-700', note: 'short' },
  over: { row: 'bg-amber-50 text-amber-800', note: 'over' },
  even: { row: 'bg-green-50 text-green-700', note: 'balanced' },
  unknown: { row: 'bg-gray-100 text-gray-700', note: 'not counted' },
};

interface ZReportDialogProps {
  /** Kept after the dialog closes, so it does not empty while it fades out. */
  readonly report: ClosedSessionReport | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

export function ZReportDialog({ report, open, onOpenChange }: ZReportDialogProps) {
  return (
    <Dialog open={open && report !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Z-report</DialogTitle>
          <DialogDescription>
            The session is closed. These are its totals as the server recorded them.
          </DialogDescription>
        </DialogHeader>
        {report && <ZReportBody report={report} />}
        <Button className="w-full" onClick={() => onOpenChange(false)}>
          Done
        </Button>
      </DialogContent>
    </Dialog>
  );
}

function ZReportBody({ report: { server, local } }: { readonly report: ClosedSessionReport }) {
  const rows = zReportRows(server, local);
  const variance = VARIANCE_STYLES[varianceTone(server.varianceMillimes)];
  const sections = [...new Set(rows.map((row) => row.section))];

  return (
    <div className="space-y-4">
      {local === null ? (
        <p className="text-sm text-gray-500">
          This device could not list every document of the session, so the report was not checked
          against its own calculation.
        </p>
      ) : (
        !sameZReport(server, local) && (
          <div
            role="alert"
            className="flex gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800"
          >
            <TriangleAlert className="h-4 w-4 shrink-0 mt-0.5" />
            <p>
              <span className="font-semibold">Discrepancy:</span> this device calculated different
              figures, shown under the recorded ones. The report recorded by the server is the one
              kept.
            </p>
          </div>
        )
      )}

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
    </div>
  );
}

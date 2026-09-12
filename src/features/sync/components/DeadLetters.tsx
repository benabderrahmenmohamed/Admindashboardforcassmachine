import { Archive } from 'lucide-react';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import { useCurrentUser } from '@/features/auth/hooks/useAuth';
import { useOutboxRecords } from '../hooks/useOutbox';
import { deadLetterHeadline, deadLetterRows, type DeadLetterRow } from './conflictView';
import { useRecordNames } from './useRecordNames';

/** How many discards the admin's first page lists before sending them to the Conflicts screen. */
const PANEL_ROWS = 3;

/**
 * The order records a person gave up on, each with what it was, why, who and when, and the code the
 * server refused it with — the four things an admin needs to find out what happened at the table.
 */
export function DeadLetterList({ rows }: { readonly rows: readonly DeadLetterRow[] }) {
  return (
    <ul className="space-y-3">
      {rows.map((row) => (
        <li key={row.id} className="rounded-lg border border-gray-200 bg-white p-3 space-y-2">
          <div>
            <p className="font-semibold text-gray-900">{row.kindLabel}</p>
            <p className="text-sm text-gray-700">{row.summary}</p>
          </div>
          <p className="text-sm text-gray-900">
            <span className="text-gray-500">Reason: </span>
            {row.reason}
          </p>
          <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-gray-500">Discarded by</dt>
              <dd className="font-medium text-gray-900">{row.discardedBy}</dd>
            </div>
            <div>
              <dt className="text-gray-500">Discarded</dt>
              <dd className="font-medium text-gray-900">
                {new Date(row.discardedAt).toLocaleString()}
              </dd>
            </div>
            <div>
              <dt className="text-gray-500">Refused with</dt>
              <dd className="font-medium text-gray-900">{row.errorCode ?? 'No code recorded'}</dd>
            </div>
          </dl>
        </li>
      ))}
    </ul>
  );
}

/**
 * This device's dead-letter list, at the top of the admin's first page. The spec reports discards to
 * the admin; this device is the only place its list exists, so the back office leads with it rather
 * than leaving it behind the sync chip. Nothing is shown while the list is empty.
 */
export function DeadLetterPanel({ conflictsPath }: { readonly conflictsPath: string }) {
  const user = useCurrentUser();
  const records = useOutboxRecords();
  const rows = deadLetterRows(records, user, useRecordNames(records));
  if (rows.length === 0) {
    return null;
  }

  return (
    <section
      aria-labelledby="dead-letter-panel-title"
      className="rounded-xl border border-amber-300 bg-amber-50 p-4 space-y-3"
    >
      <div className="flex items-start gap-3">
        <Archive className="mt-0.5 h-5 w-5 shrink-0 text-amber-700" aria-hidden="true" />
        <div>
          <h2 id="dead-letter-panel-title" className="font-semibold text-gray-900">
            {deadLetterHeadline(rows.length)}
          </h2>
          <p className="text-sm text-gray-700">
            Each one stopped this device’s queue and was given up on, with a reason. What it would
            have done to a table may never have happened, so check the tables they name.
          </p>
        </div>
      </div>
      <DeadLetterList rows={rows.slice(0, PANEL_ROWS)} />
      <Button asChild variant="outline" className="min-h-11">
        <Link to={conflictsPath}>
          {rows.length > PANEL_ROWS
            ? `See all ${rows.length} on the Conflicts screen`
            : 'Open the Conflicts screen'}
        </Link>
      </Button>
    </section>
  );
}

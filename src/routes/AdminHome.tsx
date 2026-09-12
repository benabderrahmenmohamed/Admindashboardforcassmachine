import { DashboardPage } from '@/features/dashboard/components/DashboardPage';
import { DeadLetterPanel } from '@/features/sync/components/DeadLetters';
import { conflictsPathOf } from './conflictsPath';

/**
 * The back office's first page. It leads with this device's dead-letter list, when there is one:
 * the spec reports discarded order records to the admin, and the owner lands here after signing in.
 */
export function AdminHome() {
  return (
    <div className="space-y-6">
      <DeadLetterPanel conflictsPath={conflictsPathOf('/admin')} />
      <DashboardPage />
    </div>
  );
}

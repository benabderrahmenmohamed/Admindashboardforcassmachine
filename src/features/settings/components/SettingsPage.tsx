import { useEffect } from 'react';
import { toast } from 'sonner';
import { ErrorState, LoadingState } from '@/components/feedback';
import { useCurrentUser } from '@/features/auth/hooks/useAuth';
import { TerminalCard } from '@/features/terminal/components/TerminalCard';
import { errorMessage } from '@/lib/errors';
import { hasRole } from '@/ports';
import { useSettings } from '../hooks/useSettings';
import { SettingsForm } from './SettingsForm';

export function SettingsPage() {
  const settingsQuery = useSettings();
  const user = useCurrentUser();

  // A failed refresh keeps the form and the user's edits on screen, so it is reported with a toast
  // as before. Only failures seen on this visit count, not one left in the cache by an earlier one.
  useEffect(() => {
    if (settingsQuery.isRefetchError && settingsQuery.isFetchedAfterMount) {
      toast.error(errorMessage(settingsQuery.error, 'Failed to fetch settings'));
    }
  }, [settingsQuery.isRefetchError, settingsQuery.isFetchedAfterMount, settingsQuery.error]);

  if (settingsQuery.isPending) {
    return <LoadingState />;
  }

  // Only a failed first load replaces the page: there is nothing to edit yet.
  if (settingsQuery.isLoadingError) {
    return <ErrorState error={settingsQuery.error} onRetry={() => void settingsQuery.refetch()} />;
  }

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900 mb-2">Settings</h1>
        <p className="text-gray-600">Configure your POS system preferences</p>
      </div>

      <div className="space-y-6">
        {/* Only an admin registers a device; the route already keeps cashiers out. */}
        {hasRole(user, ['admin']) && <TerminalCard />}
        <SettingsForm settings={settingsQuery.data} />
      </div>
    </div>
  );
}

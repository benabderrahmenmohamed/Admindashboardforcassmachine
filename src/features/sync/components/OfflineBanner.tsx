import { WifiOff } from 'lucide-react';
import { useAuth } from '@/features/auth/hooks/useAuth';
import { useOnline } from '../hooks/useOnline';

/**
 * Shown while this device has no network, or while it has one but cannot reach the server. Selling
 * carries on either way: the records are kept here and go out on their own once the server answers.
 */
export function OfflineBanner() {
  const online = useOnline();
  const { state } = useAuth();
  const unreachable = state.status === 'offline';

  if (online && !unreachable) {
    return null;
  }

  return (
    <div
      role="status"
      className="mb-4 flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"
    >
      <WifiOff className="mt-0.5 h-4 w-4 shrink-0" />
      <p>
        {online
          ? 'The server cannot be reached. Keep selling: what you record is kept on this device and sent as soon as it answers.'
          : 'This device is offline. Keep selling: what you record is kept here and sent as soon as the connection is back.'}
      </p>
    </div>
  );
}

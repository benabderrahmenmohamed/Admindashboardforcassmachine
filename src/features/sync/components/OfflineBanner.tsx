import { WifiOff } from 'lucide-react';
import { useAuth } from '@/features/auth/hooks/useAuth';
import { useOnline } from '../hooks/useOnline';

/** What each face can still do without the server, in the words of whoever is looking at it. */
export type OfflineFace = 'caisse' | 'serveur' | 'kitchen' | 'admin';

const CARRY_ON: Record<OfflineFace, string> = {
  caisse: 'Keep selling: what you record is kept on this device and sent as soon as it answers.',
  serveur: 'Keep taking orders: what you tap is kept on this phone and sent as soon as it answers.',
  // The one thing a kitchen must be told: the board is frozen. Marking a dish prepared still works.
  kitchen:
    'New tickets will not arrive until it answers. What you mark prepared is kept here and sent then.',
  admin: 'What is on screen may be out of date, and changes wait until it answers.',
};

/**
 * Shown while this device has no network, or while it has one but cannot reach the server. Every
 * face carries on — the records are kept here and go out on their own once the server answers — but
 * what carrying on means differs, and for the kitchen it is mostly a warning.
 */
export function OfflineBanner({ face }: { readonly face: OfflineFace }) {
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
        {online ? 'The server cannot be reached. ' : 'This device is offline. '}
        {CARRY_ON[face]}
      </p>
    </div>
  );
}

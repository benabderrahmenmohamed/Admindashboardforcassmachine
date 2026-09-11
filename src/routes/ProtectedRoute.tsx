import { WifiOff } from 'lucide-react';
import type { ReactNode } from 'react';
import { Navigate } from 'react-router';
import { FullPageLoading } from '@/components/feedback';
import { useAuth } from '@/features/auth/hooks/useAuth';
import { homePathFor } from '@/features/auth/roles';
import type { Role } from '@/ports';

/**
 * Renders `children` only for a signed-in user whose role is in `allow`. Anyone else is sent to the
 * login page or to their own home page. `allowOffline` lets a user with a stored session in while
 * the backend is unreachable; only the register needs that.
 */
export function ProtectedRoute({
  allow,
  allowOffline = false,
  children,
}: {
  allow: readonly Role[];
  allowOffline?: boolean;
  children: ReactNode;
}) {
  const { state } = useAuth();

  if (state.status === 'loading') {
    return <FullPageLoading />;
  }
  if (state.status === 'anonymous') {
    return <Navigate to="/" replace />;
  }
  if (!allow.includes(state.user.role)) {
    return <Navigate to={homePathFor(state.user.role)} replace />;
  }
  if (state.status === 'offline' && !allowOffline) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4" role="alert">
        <div className="text-center max-w-sm">
          <WifiOff className="w-10 h-10 text-gray-400 mx-auto mb-4" />
          <p className="font-semibold text-gray-900">You are offline</p>
          <p className="mt-2 text-sm text-gray-600">Reconnect to use this page.</p>
        </div>
      </div>
    );
  }
  return <>{children}</>;
}

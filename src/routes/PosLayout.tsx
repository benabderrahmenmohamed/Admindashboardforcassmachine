import { LogOut, User } from 'lucide-react';
import { Outlet, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useAuth, useCurrentUser } from '@/features/auth/hooks/useAuth';
import { OfflineBanner } from '@/features/sync/components/OfflineBanner';
import { SyncChip } from '@/features/sync/components/SyncChip';
import { errorMessage } from '@/lib/errors';

export function PosLayout() {
  const { signOut } = useAuth();
  const user = useCurrentUser();
  const navigate = useNavigate();

  const handleLogout = async () => {
    try {
      await signOut();
    } catch (error) {
      toast.error(errorMessage(error, 'Logout failed'));
      return;
    }
    void navigate('/', { replace: true });
  };

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Top Bar */}
      <div className="bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-bold text-gray-900">POS Terminal</h1>
        </div>
        <div className="flex items-center gap-4">
          <SyncChip conflictsPath="/pos/conflicts" />
          <div className="flex items-center gap-2 px-3 py-2 bg-gray-100 rounded-lg">
            <User className="w-4 h-4 text-gray-600" />
            <div className="text-left">
              <p className="text-sm font-semibold text-gray-900">{user.name}</p>
              <p className="text-xs text-gray-500">{user.role}</p>
            </div>
          </div>
          <Button variant="outline" onClick={() => void handleLogout()}>
            <LogOut className="mr-2 h-4 w-4" />
            Logout
          </Button>
        </div>
      </div>

      {/* Main Content */}
      <main className="p-4">
        <OfflineBanner />
        <Outlet />
      </main>
    </div>
  );
}

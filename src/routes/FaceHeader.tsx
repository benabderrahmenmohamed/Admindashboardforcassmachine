import { LogOut } from 'lucide-react';
import { useCallback, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useAuth, useCurrentUser } from '@/features/auth/hooks/useAuth';
import { facesFor, type FacePath } from '@/features/auth/roles';
import { SyncChip } from '@/features/sync/components/SyncChip';
import { errorMessage } from '@/lib/errors';

/** Signs out and returns to the way in. Every face's header offers it. */
export function useSignOut(): () => void {
  const { signOut } = useAuth();
  const navigate = useNavigate();
  return useCallback(() => {
    void (async () => {
      try {
        await signOut();
      } catch (error) {
        toast.error(errorMessage(error, 'Logout failed'));
        return;
      }
      void navigate('/', { replace: true });
    })();
  }, [navigate, signOut]);
}

/**
 * The other faces this user may open. The owner holds admin and cashier, so the back office and the
 * counter are one tap apart instead of a sign-out away; a member with a single role sees nothing.
 */
export function FaceSwitcher({ current }: { readonly current: FacePath }) {
  const user = useCurrentUser();
  const elsewhere = facesFor(user).filter((face) => face.path !== current);
  if (elsewhere.length === 0) {
    return null;
  }
  return (
    <nav aria-label="Switch screen" className="flex items-center gap-2">
      {elsewhere.map((face) => (
        <Link
          key={face.path}
          to={face.path}
          className="min-h-11 flex items-center px-3 rounded-lg border border-gray-200 text-sm font-medium text-gray-700 hover:bg-gray-100"
        >
          {face.label}
        </Link>
      ))}
    </nav>
  );
}

/**
 * The bar every face but the back office wears: who is signed in, where else they can go, how the
 * queue is doing, and the way out. Touch targets are 44 px tall, because the same bar is on a phone.
 */
export function FaceHeader({
  title,
  current,
  conflictsPath,
  children,
}: {
  readonly title: string;
  readonly current: FacePath;
  /** Where the sync chip sends a person to review the queue, or null when this face has no screen for it. */
  readonly conflictsPath: string | null;
  /** Anything the face puts in the bar itself, shown before the user's details. */
  readonly children?: ReactNode;
}) {
  const user = useCurrentUser();
  const signOut = useSignOut();
  return (
    <header className="bg-white border-b border-gray-200 px-3 py-2 flex items-center gap-2 flex-wrap">
      <h1 className="text-lg font-bold text-gray-900 mr-auto">{title}</h1>
      {children}
      <FaceSwitcher current={current} />
      {conflictsPath !== null && <SyncChip conflictsPath={conflictsPath} />}
      <span className="hidden sm:block text-sm text-gray-600 px-2" title={user.email}>
        {user.name}
      </span>
      <Button variant="outline" className="min-h-11" onClick={signOut} aria-label="Logout">
        <LogOut className="h-4 w-4" />
        <span className="ml-2 hidden sm:inline">Logout</span>
      </Button>
    </header>
  );
}

import { Navigate } from 'react-router';
import { FullPageLoading } from '@/components/feedback';
import { LoginPage } from '@/features/auth/components/LoginPage';
import { useAuth } from '@/features/auth/hooks/useAuth';
import { homePathFor } from '@/features/auth/roles';
import { NoFace } from './NoFace';

/**
 * The way in. Nobody signed in sees the login form; anyone already signed in — including a device
 * that only has its stored session because the backend is unreachable — goes straight on to the
 * first face their roles allow, so a waiter's phone reopens on the room and the owner on the office.
 */
export function Landing() {
  const { state } = useAuth();

  if (state.status === 'loading') {
    return <FullPageLoading />;
  }
  if (state.status === 'anonymous') {
    return <LoginPage />;
  }
  const home = homePathFor(state.user);
  return home === null ? <NoFace user={state.user} /> : <Navigate to={home} replace />;
}

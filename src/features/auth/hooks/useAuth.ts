import { useContext } from 'react';
import { AppError } from '@/lib/errors';
import type { AuthUser } from '@/ports';
import { AuthContext } from '../authContext';
import type { AuthContextValue } from '../types';

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) {
    throw new AppError('CONFIG_ERROR', 'useAuth must be used inside AuthProvider');
  }
  return value;
}

/** The signed-in user, online or offline. Only for pages behind ProtectedRoute. */
export function useCurrentUser(): AuthUser {
  const { state } = useAuth();
  if (state.status === 'authenticated' || state.status === 'offline') {
    return state.user;
  }
  throw new AppError('UNAUTHENTICATED', 'No signed-in user');
}

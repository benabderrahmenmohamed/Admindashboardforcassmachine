import type { Role } from '@/ports';

/** Where each role lands after signing in, and where a guard sends it from a page it cannot use. */
export function homePathFor(role: Role): '/dashboard' | '/pos' {
  return role === 'admin' ? '/dashboard' : '/pos';
}

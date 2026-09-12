import { UserX } from 'lucide-react';
import type { AuthUser } from '@/ports';

/**
 * A signed-in member whose roles open none of the four faces. It is a configuration mistake rather
 * than a refusal, so it names the account and its roles instead of sending the person somewhere.
 */
export function NoFace({ user }: { readonly user: AuthUser }) {
  return (
    <div className="min-h-screen flex items-center justify-center p-4" role="alert">
      <div className="text-center max-w-sm">
        <UserX className="w-10 h-10 text-gray-400 mx-auto mb-4" />
        <p className="font-semibold text-gray-900">No screen for this account</p>
        <p className="mt-2 text-sm text-gray-600">
          {user.email} is a member of the shop with {user.roles.join(', ')}, which opens none of the
          four screens. Ask an admin to change the roles on this account.
        </p>
      </div>
    </div>
  );
}

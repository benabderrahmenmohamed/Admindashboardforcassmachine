import { CloudOff, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import type { LocalSync } from '../overlay';

/**
 * A change this device made that the server does not show yet: amber while it waits to go out, red
 * once the server has refused it. The icon tells the two apart at a glance; the words say which
 * change it is, so nobody has to know the colours.
 */
export function LocalBadge({
  sync,
  children,
}: {
  readonly sync: LocalSync;
  readonly children: ReactNode;
}) {
  const Icon = sync === 'conflict' ? TriangleAlert : CloudOff;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap ${
        sync === 'conflict'
          ? 'border-red-300 bg-red-50 text-red-700'
          : 'border-amber-300 bg-amber-50 text-amber-800'
      }`}
    >
      <Icon className="h-3 w-3" aria-hidden="true" />
      {children}
    </span>
  );
}

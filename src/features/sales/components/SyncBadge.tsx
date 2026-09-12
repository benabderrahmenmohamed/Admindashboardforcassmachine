import { Ban, Check, CloudOff, TriangleAlert, type LucideIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import type { SyncStatus } from '@/features/pos/queue';
import { syncStatusLabel } from '@/features/pos/recording';

type BadgeVariant = 'default' | 'secondary' | 'destructive' | 'outline';

const STYLES: Record<
  SyncStatus,
  { readonly variant: BadgeVariant; readonly className: string; readonly Icon: LucideIcon }
> = {
  synced: { variant: 'secondary', className: 'text-green-700', Icon: Check },
  pending: { variant: 'outline', className: 'text-amber-700 border-amber-300', Icon: CloudOff },
  conflict: { variant: 'destructive', className: '', Icon: TriangleAlert },
  voided: { variant: 'outline', className: 'text-gray-500', Icon: Ban },
};

/** How far a document got: on this device, on its way, refused, or given up on. */
export function SyncBadge({ status }: { readonly status: SyncStatus }) {
  const { variant, className, Icon } = STYLES[status];
  return (
    <Badge variant={variant} className={className}>
      <Icon />
      {syncStatusLabel(status)}
    </Badge>
  );
}

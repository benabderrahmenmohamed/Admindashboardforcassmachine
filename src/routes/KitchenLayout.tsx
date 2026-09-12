import { Outlet } from 'react-router';
import { OfflineBanner } from '@/features/sync/components/OfflineBanner';
import { FaceHeader } from './FaceHeader';

/**
 * The kitchen screen: tickets and nothing else, on whatever is bolted to the pass. Marking an item
 * prepared is a queued record too, so the header's sync chip leads to /kitchen/conflicts.
 */
export function KitchenLayout() {
  return (
    <div className="min-h-screen bg-gray-50">
      <FaceHeader title="Cuisine" current="/kitchen" />
      <OfflineBanner face="kitchen" />
      <main>
        <Outlet />
      </main>
    </div>
  );
}

import { Outlet } from 'react-router';
import { OfflineBanner } from '@/features/sync/components/OfflineBanner';
import { FaceHeader } from './FaceHeader';

/** The kitchen screen: tickets and nothing else, on whatever is bolted to the pass. */
export function KitchenLayout() {
  return (
    <div className="min-h-screen bg-gray-50">
      <FaceHeader title="Cuisine" current="/kitchen" conflictsPath={null} />
      <OfflineBanner />
      <main>
        <Outlet />
      </main>
    </div>
  );
}

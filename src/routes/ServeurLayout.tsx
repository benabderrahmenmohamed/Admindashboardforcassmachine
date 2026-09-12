import { Outlet } from 'react-router';
import { OfflineBanner } from '@/features/sync/components/OfflineBanner';
import { FaceHeader } from './FaceHeader';

/**
 * The waiter's app. Mobile first: the header is one row of 44 px targets, the page below it is the
 * whole screen, and nothing is laid out for a mouse.
 *
 * There is no queue to review here — this face writes order events, not receipts — so the header
 * carries no sync chip; the offline banner still says when the phone has lost the network.
 */
export function ServeurLayout() {
  return (
    <div className="min-h-screen bg-gray-50">
      <FaceHeader title="Salle" current="/serveur" conflictsPath={null} />
      <OfflineBanner />
      <main>
        <Outlet />
      </main>
    </div>
  );
}

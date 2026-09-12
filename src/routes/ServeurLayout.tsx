import { Outlet } from 'react-router';
import { OfflineBanner } from '@/features/sync/components/OfflineBanner';
import { FaceHeader } from './FaceHeader';

/**
 * The waiter's app. Mobile first: the header is one row of 44 px targets, the page below it is the
 * whole screen, and nothing is laid out for a mouse.
 *
 * The phone queues every item it puts on a table, so its header carries the sync chip like every
 * other face, leading to /serveur/conflicts: an order the table has overtaken stops this queue, and
 * the waiter holding the phone is the one who can discard it.
 */
export function ServeurLayout() {
  return (
    <div className="min-h-screen bg-gray-50">
      <FaceHeader title="Salle" current="/serveur" />
      <OfflineBanner face="serveur" />
      <main>
        <Outlet />
      </main>
    </div>
  );
}

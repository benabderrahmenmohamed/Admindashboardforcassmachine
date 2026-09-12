import { Outlet } from 'react-router';
import { OfflineBanner } from '@/features/sync/components/OfflineBanner';
import { FaceHeader } from './FaceHeader';

/** The counter: one screen, the room and the table being paid. */
export function CaisseLayout() {
  return (
    <div className="min-h-screen bg-gray-50">
      <FaceHeader title="Caisse" current="/caisse" conflictsPath="/caisse/conflicts" />
      <main className="p-4">
        <OfflineBanner />
        <Outlet />
      </main>
    </div>
  );
}

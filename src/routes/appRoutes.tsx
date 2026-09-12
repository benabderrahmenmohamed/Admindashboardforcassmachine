import type { RouteObject } from 'react-router';
import { MenuPage } from '@/features/admin/components/MenuPage';
import { RemovedItemsPage } from '@/features/admin/components/RemovedItemsPage';
import { TablesPage } from '@/features/admin/components/TablesPage';
import { faceAt } from '@/features/auth/roles';
import { CaissePage } from '@/features/caisse/components/CaissePage';
import { CategoriesPage } from '@/features/categories/components/CategoriesPage';
import { KitchenPage } from '@/features/kitchen/components/KitchenPage';
import { ProductsPage } from '@/features/products/components/ProductsPage';
import { ServeurPage } from '@/features/serveur/components/ServeurPage';
import { TablePage } from '@/features/serveur/components/TablePage';
import { SettingsPage } from '@/features/settings/components/SettingsPage';
import { ConflictsPage } from '@/features/sync/components/ConflictsPage';
import { AdminHome } from './AdminHome';
import { AdminLayout } from './AdminLayout';
import { CaisseLayout } from './CaisseLayout';
import { CONFLICTS_SEGMENT } from './conflictsPath';
import { KitchenLayout } from './KitchenLayout';
import { Landing } from './Landing';
import { ProtectedRoute } from './ProtectedRoute';
import { RouteError } from './RouteError';
import { ServeurLayout } from './ServeurLayout';

/**
 * One app, four faces. Each face declares the roles it is for in one place — `FACES` in
 * src/features/auth/roles.ts — so the guard here and the switcher in the layouts can never disagree
 * about who may open what, and a user who lands on a face they cannot use is sent to their own.
 *
 * Every face has a Conflicts screen at `<face>/conflicts`, where its sync chip leads: every device
 * queues records, and a waiter's phone, whose queue one stale order can stop, needs it most. The
 * tree is kept apart from the browser router so a test mounts these very routes in memory.
 */
export const appRoutes: RouteObject[] = [
  {
    // Signed out: the login form. Signed in: on to the first face these roles allow.
    path: '/',
    element: <Landing />,
    errorElement: <RouteError />,
  },
  {
    path: '/admin',
    element: (
      <ProtectedRoute allow={faceAt('/admin').allow}>
        <AdminLayout />
      </ProtectedRoute>
    ),
    errorElement: <RouteError />,
    children: [
      { index: true, element: <AdminHome /> },
      { path: 'menu', element: <MenuPage /> },
      { path: 'products', element: <ProductsPage /> },
      { path: 'categories', element: <CategoriesPage /> },
      { path: 'tables', element: <TablesPage /> },
      { path: 'removed', element: <RemovedItemsPage /> },
      { path: 'settings', element: <SettingsPage /> },
      // This device's queue, on both sides: an admin is the only one who can void a receipt.
      { path: CONFLICTS_SEGMENT, element: <ConflictsPage home="/admin" /> },
    ],
  },
  {
    path: '/caisse',
    element: (
      <ProtectedRoute allow={faceAt('/caisse').allow} allowOffline>
        <CaisseLayout />
      </ProtectedRoute>
    ),
    errorElement: <RouteError />,
    children: [
      { index: true, element: <CaissePage /> },
      { path: CONFLICTS_SEGMENT, element: <ConflictsPage home="/caisse" /> },
    ],
  },
  {
    path: '/serveur',
    element: (
      <ProtectedRoute allow={faceAt('/serveur').allow} allowOffline>
        <ServeurLayout />
      </ProtectedRoute>
    ),
    errorElement: <RouteError />,
    children: [
      { index: true, element: <ServeurPage /> },
      { path: 'table/:tableId', element: <TablePage /> },
      {
        // The room's layout runs edge to edge and each of its pages pads itself; so does this one.
        path: CONFLICTS_SEGMENT,
        element: (
          <div className="p-3">
            <ConflictsPage home="/serveur" />
          </div>
        ),
      },
    ],
  },
  {
    path: '/kitchen',
    element: (
      // Offline too: the kitchen queues what it marks prepared like any other device, and its banner
      // says the board has stopped receiving tickets.
      <ProtectedRoute allow={faceAt('/kitchen').allow} allowOffline>
        <KitchenLayout />
      </ProtectedRoute>
    ),
    errorElement: <RouteError />,
    children: [
      { index: true, element: <KitchenPage /> },
      {
        path: CONFLICTS_SEGMENT,
        element: (
          <div className="p-3">
            <ConflictsPage home="/kitchen" />
          </div>
        ),
      },
    ],
  },
];

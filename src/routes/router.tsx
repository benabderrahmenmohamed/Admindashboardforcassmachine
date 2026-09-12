import { createBrowserRouter } from 'react-router';
import { MenuPage } from '@/features/admin/components/MenuPage';
import { RemovedItemsPage } from '@/features/admin/components/RemovedItemsPage';
import { TablesPage } from '@/features/admin/components/TablesPage';
import { faceAt } from '@/features/auth/roles';
import { CaissePage } from '@/features/caisse/components/CaissePage';
import { CategoriesPage } from '@/features/categories/components/CategoriesPage';
import { DashboardPage } from '@/features/dashboard/components/DashboardPage';
import { KitchenPage } from '@/features/kitchen/components/KitchenPage';
import { ProductsPage } from '@/features/products/components/ProductsPage';
import { ServeurPage } from '@/features/serveur/components/ServeurPage';
import { TablePage } from '@/features/serveur/components/TablePage';
import { SettingsPage } from '@/features/settings/components/SettingsPage';
import { ConflictsPage } from '@/features/sync/components/ConflictsPage';
import { AdminLayout } from './AdminLayout';
import { CaisseLayout } from './CaisseLayout';
import { KitchenLayout } from './KitchenLayout';
import { Landing } from './Landing';
import { ProtectedRoute } from './ProtectedRoute';
import { RouteError } from './RouteError';
import { ServeurLayout } from './ServeurLayout';

/**
 * One app, four faces. Each face declares the roles it is for in one place — `FACES` in
 * src/features/auth/roles.ts — so the guard here and the switcher in the layouts can never disagree
 * about who may open what, and a user who lands on a face they cannot use is sent to their own.
 */
export const router = createBrowserRouter([
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
      { index: true, element: <DashboardPage /> },
      { path: 'menu', element: <MenuPage /> },
      { path: 'products', element: <ProductsPage /> },
      { path: 'categories', element: <CategoriesPage /> },
      { path: 'tables', element: <TablesPage /> },
      { path: 'removed', element: <RemovedItemsPage /> },
      { path: 'settings', element: <SettingsPage /> },
      // This device's queue, on both sides: an admin is the only one who can void a receipt.
      { path: 'conflicts', element: <ConflictsPage home="/admin" /> },
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
      { path: 'conflicts', element: <ConflictsPage home="/caisse" /> },
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
    ],
  },
  {
    path: '/kitchen',
    element: (
      <ProtectedRoute allow={faceAt('/kitchen').allow}>
        <KitchenLayout />
      </ProtectedRoute>
    ),
    errorElement: <RouteError />,
    children: [{ index: true, element: <KitchenPage /> }],
  },
]);

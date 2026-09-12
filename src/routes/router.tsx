import { createBrowserRouter } from 'react-router';
import { LoginPage } from '@/features/auth/components/LoginPage';
import { CategoriesPage } from '@/features/categories/components/CategoriesPage';
import { DashboardPage } from '@/features/dashboard/components/DashboardPage';
import { PosPage } from '@/features/pos/components/PosPage';
import { ProductsPage } from '@/features/products/components/ProductsPage';
import { SettingsPage } from '@/features/settings/components/SettingsPage';
import { ConflictsPage } from '@/features/sync/components/ConflictsPage';
import { DashboardLayout } from './DashboardLayout';
import { PosLayout } from './PosLayout';
import { ProtectedRoute } from './ProtectedRoute';
import { RouteError } from './RouteError';

export const router = createBrowserRouter([
  {
    path: '/',
    element: <LoginPage />,
    errorElement: <RouteError />,
  },
  {
    path: '/dashboard',
    element: (
      <ProtectedRoute allow={['admin']}>
        <DashboardLayout />
      </ProtectedRoute>
    ),
    errorElement: <RouteError />,
    children: [
      { index: true, element: <DashboardPage /> },
      { path: 'products', element: <ProductsPage /> },
      { path: 'categories', element: <CategoriesPage /> },
      { path: 'settings', element: <SettingsPage /> },
      // This device's queue, on both sides: an admin is the only one who can void a receipt.
      { path: 'conflicts', element: <ConflictsPage home="/dashboard" /> },
    ],
  },
  {
    path: '/pos',
    element: (
      <ProtectedRoute allow={['cashier']} allowOffline>
        <PosLayout />
      </ProtectedRoute>
    ),
    errorElement: <RouteError />,
    children: [
      { index: true, element: <PosPage /> },
      { path: 'conflicts', element: <ConflictsPage home="/pos" /> },
    ],
  },
]);

import { createBrowserRouter } from 'react-router';
import { Login } from './pages/Login';
import { Dashboard } from './pages/Dashboard';
import { Products } from './pages/Products';
import { Categories } from './pages/Categories';
import { Settings } from './pages/Settings';
import { DashboardLayout } from './components/DashboardLayout';
import { POS } from './pages/POS';
import { POSLayout } from './components/POSLayout';

export const router = createBrowserRouter([
  {
    path: '/',
    element: <Login />,
  },
  {
    path: '/dashboard',
    element: <DashboardLayout />,
    children: [
      { index: true, element: <Dashboard /> },
      { path: 'products', element: <Products /> },
      { path: 'categories', element: <Categories /> },
      { path: 'settings', element: <Settings /> },
    ],
  },
  {
    path: '/pos',
    element: <POSLayout />,
    children: [{ index: true, element: <POS /> }],
  },
]);

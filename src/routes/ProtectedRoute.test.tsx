import { screen } from '@testing-library/react';
import type { RouteObject } from 'react-router';
import { describe, expect, it } from 'vitest';
import { createHarness } from '@/test/harness';
import { ProtectedRoute } from './ProtectedRoute';

/** The app's own guards, over the three pages the router puts behind them. */
const routes: RouteObject[] = [
  { path: '/', element: <p>Sign in</p> },
  {
    path: '/dashboard',
    element: (
      <ProtectedRoute allow={['admin']}>
        <p>Dashboard</p>
      </ProtectedRoute>
    ),
  },
  {
    path: '/pos',
    element: (
      <ProtectedRoute allow={['cashier']} allowOffline>
        <p>Register</p>
      </ProtectedRoute>
    ),
  },
];

describe('ProtectedRoute', () => {
  it('sends a cashier who opens the dashboard to the register', async () => {
    const harness = await createHarness({ signedInAs: 'Cashier' });

    harness.renderRoutes(routes, '/dashboard');

    expect(await screen.findByText('Register')).toBeDefined();
    expect(screen.queryByText('Dashboard')).toBeNull();
  });

  it('sends an admin who opens the register to the dashboard', async () => {
    const harness = await createHarness({ signedInAs: 'Admin' });

    harness.renderRoutes(routes, '/pos');

    expect(await screen.findByText('Dashboard')).toBeDefined();
    expect(screen.queryByText('Register')).toBeNull();
  });

  it('sends someone who is not signed in to the login page', async () => {
    const harness = await createHarness();

    harness.renderRoutes(routes, '/dashboard');

    expect(await screen.findByText('Sign in')).toBeDefined();
    expect(screen.queryByText('Dashboard')).toBeNull();
  });

  it('shows the page to the role it allows', async () => {
    const harness = await createHarness({ signedInAs: 'Admin' });

    harness.renderRoutes(routes, '/dashboard');

    expect(await screen.findByText('Dashboard')).toBeDefined();
  });
});

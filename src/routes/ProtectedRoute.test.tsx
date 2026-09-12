import { screen } from '@testing-library/react';
import type { RouteObject } from 'react-router';
import { describe, expect, it } from 'vitest';
import { faceAt, type FacePath } from '@/features/auth/roles';
import { createHarness } from '@/test/harness';
import { ProtectedRoute } from './ProtectedRoute';

/**
 * The four faces behind the app's own guards, each declaring the roles the router declares for it,
 * so this test moves with `FACES` instead of restating it.
 */
function face(path: FacePath, label: string): RouteObject {
  return {
    path,
    element: (
      <ProtectedRoute allow={faceAt(path).allow}>
        <p>{label}</p>
      </ProtectedRoute>
    ),
  };
}

const routes: RouteObject[] = [
  { path: '/', element: <p>Sign in</p> },
  face('/admin', 'Back office'),
  face('/caisse', 'Counter'),
  face('/serveur', 'Room'),
  face('/kitchen', 'Kitchen'),
];

describe('ProtectedRoute', () => {
  it('sends a cashier who opens the back office to the counter', async () => {
    const harness = await createHarness({ signedInAs: 'Cashier' });

    harness.renderRoutes(routes, '/admin');

    expect(await screen.findByText('Counter')).toBeDefined();
    expect(screen.queryByText('Back office')).toBeNull();
  });

  it('lets the owner work the counter as well as the back office', async () => {
    const harness = await createHarness({ signedInAs: 'Owner' });

    harness.renderRoutes(routes, '/caisse');

    expect(await screen.findByText('Counter')).toBeDefined();
  });

  it('does not let the owner take orders in the room, and sends them to their own screen', async () => {
    const harness = await createHarness({ signedInAs: 'Owner' });

    harness.renderRoutes(routes, '/serveur');

    expect(await screen.findByText('Back office')).toBeDefined();
    expect(screen.queryByText('Room')).toBeNull();
  });

  it('sends a waiter who opens the kitchen back to the room', async () => {
    const harness = await createHarness({ signedInAs: 'Waiter' });

    harness.renderRoutes(routes, '/kitchen');

    expect(await screen.findByText('Room')).toBeDefined();
    expect(screen.queryByText('Kitchen')).toBeNull();
  });

  it('opens the kitchen for the kitchen', async () => {
    const harness = await createHarness({ signedInAs: 'Kitchen' });

    harness.renderRoutes(routes, '/kitchen');

    expect(await screen.findByText('Kitchen')).toBeDefined();
  });

  it('sends someone who is not signed in to the login page', async () => {
    const harness = await createHarness();

    harness.renderRoutes(routes, '/admin');

    expect(await screen.findByText('Sign in')).toBeDefined();
    expect(screen.queryByText('Back office')).toBeNull();
  });

  it('shows the face to a role it allows', async () => {
    const harness = await createHarness({ signedInAs: 'Owner' });

    harness.renderRoutes(routes, '/admin');

    expect(await screen.findByText('Back office')).toBeDefined();
  });
});

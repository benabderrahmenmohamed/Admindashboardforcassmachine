import { describe, expect, it } from 'vitest';
import type { AuthUser, Role } from '@/ports';
import { faceAt, facesFor, FACES, homePathFor } from './roles';

function member(...roles: Role[]): AuthUser {
  return { id: 'u1', email: 'u@example.com', name: 'U', roles, shopId: 'shop-1' };
}

describe('facesFor', () => {
  it('gives a cashier the counter and nothing else', () => {
    expect(facesFor(member('cashier')).map((face) => face.path)).toEqual(['/caisse']);
  });

  it('gives a waiter the room and nothing else', () => {
    expect(facesFor(member('waiter')).map((face) => face.path)).toEqual(['/serveur']);
  });

  it('gives the owner both the back office and the counter', () => {
    expect(facesFor(member('admin', 'cashier')).map((face) => face.path)).toEqual([
      '/admin',
      '/caisse',
      '/kitchen',
    ]);
  });

  it('does not let an admin take orders in the room', () => {
    expect(facesFor(member('admin')).map((face) => face.path)).not.toContain('/serveur');
  });

  it('keeps the order of FACES however the roles are listed', () => {
    expect(facesFor(member('kitchen', 'cashier')).map((face) => face.path)).toEqual([
      '/caisse',
      '/kitchen',
    ]);
  });
});

describe('homePathFor', () => {
  it('lands the owner in the back office', () => {
    expect(homePathFor(member('admin', 'cashier'))).toBe('/admin');
  });

  it('lands a waiter in the room and a cook in the kitchen', () => {
    expect(homePathFor(member('waiter'))).toBe('/serveur');
    expect(homePathFor(member('kitchen'))).toBe('/kitchen');
  });

  it('lands a cashier at the counter', () => {
    expect(homePathFor(member('cashier'))).toBe('/caisse');
  });
});

describe('FACES', () => {
  it('covers every role, so no signed-in member is left without a screen', () => {
    const covered = new Set(FACES.flatMap((face) => face.allow));
    for (const role of ['admin', 'cashier', 'waiter', 'kitchen'] as const) {
      expect(covered.has(role)).toBe(true);
    }
  });

  it('finds a face by its path', () => {
    expect(faceAt('/kitchen').label).toBe('Cuisine');
  });
});

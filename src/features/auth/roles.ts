import { hasRole, type AuthUser, type Role } from '@/ports';

/**
 * The four faces of the one app. A face is a whole screen a person works in for a shift, not a page:
 * the admin's back office, the counter, the waiter's phone and the kitchen.
 *
 * Several roles reach the same face on purpose. The spec gives the admin what the kitchen and the
 * counter can do (`order_item_prepare` is "kitchen, admin", `order_cancel` and a line discount are
 * "cashier, admin"), and the owner of a café holds `['admin', 'cashier']` as the ordinary case. The
 * waiter's face is the one exception: taking an order is a waiter's job and nothing in the spec
 * hands it to an admin, so `/serveur` stays waiters-only.
 *
 * Order is the order a person is offered them: the first face a user's roles allow is where signing
 * in lands them, so the owner lands in the back office and reaches the counter from the switcher.
 */
export interface Face {
  readonly path: FacePath;
  /** What the switcher and the layout call it. */
  readonly label: string;
  readonly allow: readonly Role[];
}

export type FacePath = '/admin' | '/caisse' | '/serveur' | '/kitchen';

const FACE_BY_PATH: Record<FacePath, Face> = {
  '/admin': { path: '/admin', label: 'Admin', allow: ['admin'] },
  '/caisse': { path: '/caisse', label: 'Caisse', allow: ['cashier', 'admin'] },
  '/serveur': { path: '/serveur', label: 'Salle', allow: ['waiter'] },
  '/kitchen': { path: '/kitchen', label: 'Cuisine', allow: ['kitchen', 'admin'] },
};

export const FACES: readonly Face[] = [
  FACE_BY_PATH['/admin'],
  FACE_BY_PATH['/caisse'],
  FACE_BY_PATH['/serveur'],
  FACE_BY_PATH['/kitchen'],
];

/** Every face `user` may open, in the order above. Empty only for a role no face covers. */
export function facesFor(user: AuthUser): Face[] {
  return FACES.filter((face) => hasRole(user, face.allow));
}

/**
 * Where a signed-in user lands, and where a guard sends one away from a face they cannot use: the
 * first face their roles allow. Null when no face covers any of their roles, which the landing page
 * says out loud rather than redirecting in a circle.
 */
export function homePathFor(user: AuthUser): FacePath | null {
  return facesFor(user)[0]?.path ?? null;
}

/** The face a path belongs to, for a layout that wants to name itself and guard itself. */
export function faceAt(path: FacePath): Face {
  return FACE_BY_PATH[path];
}

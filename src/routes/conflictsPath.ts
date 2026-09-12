import type { FacePath } from '@/features/auth/roles';

/** Where every face mounts its Conflicts screen, under its own path. */
export const CONFLICTS_SEGMENT = 'conflicts';

/**
 * A face's own Conflicts screen, where its sync chip leads. One function for the chips and the
 * route tree, so a chip can never point at a face that has no screen there.
 */
export function conflictsPathOf(face: FacePath): string {
  return `${face}/${CONFLICTS_SEGMENT}`;
}

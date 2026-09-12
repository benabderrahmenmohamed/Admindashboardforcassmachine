import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthContext } from '@/features/auth/authContext';
import type { AuthViewState } from '@/features/auth/types';
import { AppError } from '@/lib/errors';
import type { AuthUser } from '@/ports';
import { OfflineBanner, type OfflineFace } from './OfflineBanner';

// The banner reads two things: whether the browser has a network, and whether the server answered
// the last attempt to reach it. Both are set here directly; neither needs a backend.

const COOK: AuthUser = {
  id: 'user-kitchen',
  email: 'kitchen@demo.local',
  name: 'Demo Kitchen',
  roles: ['kitchen'],
  shopId: 'shop-1',
};

function showBanner(face: OfflineFace, state: AuthViewState, online: boolean) {
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(online);
  const refuse = () => Promise.reject(new AppError('UNKNOWN', 'not used by the banner'));
  return render(
    <AuthContext.Provider value={{ state, signIn: refuse, signOut: refuse }}>
      <OfflineBanner face={face} />
    </AuthContext.Provider>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('OfflineBanner', () => {
  it('says nothing while the device is online and the server answers', () => {
    showBanner('kitchen', { status: 'authenticated', user: COOK }, true);

    expect(screen.queryByRole('status')).toBeNull();
  });

  it.each<[OfflineFace, RegExp]>([
    ['caisse', /Keep selling/],
    ['serveur', /Keep taking orders/],
    // A cook is not told to carry on as normal: the board has stopped receiving tickets.
    ['kitchen', /New tickets will not arrive until it answers/],
    ['admin', /may be out of date/],
  ])('tells the %s face what still works without a network', (face, words) => {
    showBanner(face, { status: 'authenticated', user: COOK }, false);

    const banner = screen.getByRole('status');
    expect(banner.textContent).toMatch(/^This device is offline\. /);
    expect(banner.textContent).toMatch(words);
  });

  it('says the server is the problem when the network is up but the server does not answer', () => {
    showBanner('kitchen', { status: 'offline', user: COOK }, true);

    const banner = screen.getByRole('status');
    expect(banner.textContent).toMatch(
      /^The server cannot be reached\. New tickets will not arrive/,
    );
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  prefs: {} as Record<string, unknown>,
}));

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`encrypted:${value}`, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8').replace(/^encrypted:/, ''),
  },
}));

vi.mock('../../src/main/desktop-prefs', () => ({
  readDesktopPrefsFile: () => structuredClone(state.prefs),
  writeDesktopPrefsFile: (next: Record<string, unknown>) => {
    state.prefs = structuredClone(next);
  },
}));

import { DesktopAuthSession } from '../../src/main/auth-session';

function response(
  payload: Record<string, unknown>,
  options: { ok?: boolean; cookie?: string } = {},
): Response {
  return {
    ok: options.ok ?? true,
    status: options.ok === false ? 401 : 200,
    headers: {
      get: (name: string) => name.toLowerCase() === 'set-cookie' ? options.cookie ?? null : null,
    },
    text: async () => JSON.stringify(payload),
  } as Response;
}

beforeEach(() => {
  state.prefs = {};
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === '/api/auth/config') {
      return response({ ok: true, mode: 'remote', configured: true, providerId: 'tenant' });
    }
    if (url.pathname === '/api/auth/login') {
      const request = JSON.parse(String(init?.body)) as { phoneNumber: string };
      const userId = request.phoneNumber;
      return response({
        ok: true,
        user: { userId, phoneNumber: request.phoneNumber, displayName: `User ${userId}` },
      }, { cookie: `crew_auth_session=session-${userId}; HttpOnly` });
    }
    if (url.pathname === '/api/auth/session') return response({ ok: true });
    return response({ ok: true });
  }));
});

describe('DesktopAuthSession account history', () => {
  it('persists separate encrypted sessions and switches the active account', async () => {
    const session = new DesktopAuthSession();
    await session.refreshConfig('http://127.0.0.1:8000');
    await session.login('http://127.0.0.1:8000', 'user-1', '1234');
    await session.login('http://127.0.0.1:8000', 'user-2', '1234');

    const accounts = session.listAccounts();
    expect(accounts.map(({ accountId, isCurrent }) => [accountId, isCurrent])).toEqual([
      ['tenant:user-2', true],
      ['tenant:user-1', false],
    ]);
    expect(accounts[0]).not.toHaveProperty('encryptedCookie');
    expect(state.prefs.authAccounts).toHaveLength(2);
    expect(JSON.stringify(state.prefs.authAccounts)).not.toContain('session-user');

    expect(session.switchAccount('tenant:user-1')).toEqual({ ok: true });
    expect(session.state().user?.userId).toBe('user-1');
    expect(session.listAccounts().find((account) => account.isCurrent)?.accountId).toBe('tenant:user-1');
  });

  it('restores the selected account after restarting the auth session', async () => {
    const firstSession = new DesktopAuthSession();
    await firstSession.refreshConfig('http://127.0.0.1:8000');
    await firstSession.login('http://127.0.0.1:8000', 'user-1', '1234');
    await firstSession.login('http://127.0.0.1:8000', 'user-2', '1234');
    firstSession.switchAccount('tenant:user-1');

    const restartedSession = new DesktopAuthSession();
    const restored = await restartedSession.refreshConfig('http://127.0.0.1:8000');

    expect(restored.isLoggedIn).toBe(true);
    expect(restored.user?.userId).toBe('user-1');
  });

  it('migrates the existing single-account session into account history', async () => {
    state.prefs.authSession = {
      providerId: 'tenant',
      encryptedCookie: Buffer.from('encrypted:crew_auth_session=legacy-session').toString('base64'),
      user: { userId: 'legacy-user', phoneNumber: 'legacy-user' },
    };
    const session = new DesktopAuthSession();

    const restored = await session.refreshConfig('http://127.0.0.1:8000');

    expect(restored.isLoggedIn).toBe(true);
    expect(session.listAccounts().map((account) => account.accountId)).toEqual(['tenant:legacy-user']);
  });

  it('removes one login record without disturbing other users', async () => {
    const session = new DesktopAuthSession();
    await session.refreshConfig('http://127.0.0.1:8000');
    await session.login('http://127.0.0.1:8000', 'user-1', '1234');
    await session.login('http://127.0.0.1:8000', 'user-2', '1234');

    expect(session.deleteAccountRecord('tenant:user-1')).toBe(true);

    expect(session.listAccounts().map((account) => account.accountId)).toEqual(['tenant:user-2']);
    expect(session.state().user?.userId).toBe('user-2');
  });

  it('logs out a remembered account without switching the active user', async () => {
    const session = new DesktopAuthSession();
    await session.refreshConfig('http://127.0.0.1:8000');
    await session.login('http://127.0.0.1:8000', 'user-1', '1234');
    await session.login('http://127.0.0.1:8000', 'user-2', '1234');

    const result = await session.logoutAccount('http://127.0.0.1:8000', 'tenant:user-1');

    expect(result.ok).toBe(true);
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      'http://127.0.0.1:8000/api/auth/logout',
      expect.objectContaining({ headers: { Cookie: 'crew_auth_session=session-user-1' } }),
    );
    expect(session.state().user?.userId).toBe('user-2');
  });
});

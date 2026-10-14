/** Provider-neutral authentication state owned by the Electron main process. */

import { safeStorage } from 'electron';
import type { AuthAccountSnapshot, AuthStateSnapshot, AuthUserSnapshot } from '../shared/types';
import { readDesktopPrefsFile, writeDesktopPrefsFile } from './desktop-prefs';

const SESSION_COOKIE_NAME = 'crew_auth_session';
const ACCOUNTS_KEY = 'authAccounts';
const ACTIVE_ACCOUNT_KEY = 'activeAuthAccountId';
const LEGACY_SESSION_KEY = 'authSession';

interface AuthConfigPayload {
  ok?: boolean;
  mode?: 'local' | 'email' | 'remote' | 'dev';
  configured?: boolean;
  providerId?: string;
}

interface StoredAuthSession {
  providerId?: string;
  encryptedCookie?: string;
  user?: AuthUserSnapshot;
  lastUsedAt?: number;
}

function parseJson(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function normalizedUser(raw: unknown): AuthUserSnapshot | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const userId = typeof record.userId === 'string' ? record.userId.trim() : '';
  const phoneNumber = typeof record.phoneNumber === 'string' ? record.phoneNumber.trim() : '';
  const displayName = typeof record.displayName === 'string' ? record.displayName.trim() : '';
  const email = typeof record.email === 'string' ? record.email.trim() : '';
  if (!userId) return null;
  return {
    userId,
    phoneNumber,
    ...(email ? { email } : {}),
    ...(displayName ? { displayName } : {}),
  };
}

function cookiePair(setCookie: string | null): string {
  if (!setCookie) return '';
  const match = setCookie.match(/(?:^|[,;]\s*)crew_auth_session=([^;\s,]+)/i);
  return match?.[1] ? `${SESSION_COOKIE_NAME}=${match[1]}` : '';
}

function syntheticUser(userId: string): AuthUserSnapshot {
  return { userId, phoneNumber: '' };
}

export class DesktopAuthSession {
  private mode: AuthStateSnapshot['mode'] = 'unknown';
  private configured = false;
  private providerId = 'custom';
  private cookie = '';
  private user: AuthUserSnapshot | null = null;
  private activeAccountId = '';

  private endpoint(baseUrl: string, pathname: string): string {
    const target = new URL(baseUrl);
    target.pathname = pathname;
    target.search = '';
    target.hash = '';
    return target.toString();
  }

  async refreshConfig(baseUrl: string): Promise<AuthStateSnapshot> {
    const previousMode = this.mode;
    const previousProviderId = this.providerId;
    const response = await fetch(this.endpoint(baseUrl, '/api/auth/config'), {
      method: 'GET',
      redirect: 'error',
    });
    const payload = parseJson(await response.text()) as AuthConfigPayload;
    if (!response.ok || payload.ok !== true) {
      throw new Error('无法读取认证配置');
    }
    this.mode = payload.mode === 'remote' || payload.mode === 'email' || payload.mode === 'dev' ? payload.mode : 'local';
    this.configured = payload.configured !== false;
    this.providerId = typeof payload.providerId === 'string' && payload.providerId.trim()
      ? payload.providerId.trim()
      : 'custom';
    if (this.mode === 'remote' || this.mode === 'email') {
      if (
        previousMode !== this.mode
        || previousProviderId !== this.providerId
        || !this.cookie
        || !this.user
      ) {
        this.restoreRemoteSession();
      }
      if (this.cookie && this.user) {
        const sessionResponse = await fetch(this.endpoint(baseUrl, '/api/auth/session'), {
          method: 'GET',
          headers: { Cookie: this.cookie },
          redirect: 'error',
        }).catch(() => null);
        if (!sessionResponse || !sessionResponse.ok) {
          this.cookie = '';
          this.user = null;
          this.clearPersistedSession();
        }
      }
    } else {
      this.cookie = '';
      this.user = syntheticUser(this.mode === 'dev' ? 'dev' : 'local');
    }
    return this.state();
  }

  state(): AuthStateSnapshot {
    const requiresSession = this.mode === 'remote' || this.mode === 'email';
    return {
      mode: this.mode,
      configured: this.configured,
      providerId: this.providerId,
      isLoggedIn: !requiresSession || Boolean(this.cookie && this.user),
      user: this.user,
    };
  }

  ownerAccountId(): string | null {
    if (this.mode === 'unknown') return null;
    if (this.mode === 'dev') return 'dev:dev';
    if (this.mode === 'local') return 'local';
    return this.user ? `${this.providerId}:${this.user.userId}` : null;
  }

  listAccounts(): AuthAccountSnapshot[] {
    const accounts = this.readStoredAccounts();
    const currentId = this.currentAccountId();
    const snapshots = accounts.flatMap((account) => {
      const user = normalizedUser(account.user);
      if (!user || !account.providerId) return [];
      const accountId = this.accountId(account.providerId, user);
      return [{
        accountId,
        providerId: account.providerId,
        user,
        isCurrent: accountId === currentId,
        lastUsedAt: account.lastUsedAt || 0,
        canSwitch: Boolean(account.encryptedCookie && safeStorage.isEncryptionAvailable()),
      }];
    });
    if (this.user && (this.mode === 'remote' || this.mode === 'email') && !snapshots.some((item) => item.accountId === currentId)) {
      snapshots.unshift({
        accountId: currentId,
        providerId: this.providerId,
        user: this.user,
        isCurrent: true,
        lastUsedAt: Date.now(),
        canSwitch: false,
      });
    }
    return snapshots.sort((left, right) => Number(right.isCurrent) - Number(left.isCurrent) || right.lastUsedAt - left.lastUsedAt);
  }

  switchAccount(accountId: string): { ok: true } | { ok: false; error: string } {
    const account = this.readStoredAccounts().find(
      (item) => item.user && this.accountId(item.providerId || '', item.user) === accountId,
    );
    if (!account || account.providerId !== this.providerId) {
      return { ok: false, error: '找不到此登录用户，或该用户不属于当前认证服务。' };
    }
    if (!account.encryptedCookie || !safeStorage.isEncryptionAvailable()) {
      return { ok: false, error: '此用户的登录凭据不可用，请重新登录。' };
    }
    try {
      const cookie = safeStorage.decryptString(Buffer.from(account.encryptedCookie, 'base64'));
      if (!cookie.startsWith(`${SESSION_COOKIE_NAME}=`)) {
        return { ok: false, error: '此用户的登录凭据无效，请重新登录。' };
      }
      this.cookie = cookie;
      this.user = account.user || null;
      this.activeAccountId = accountId;
      this.touchStoredAccount(accountId);
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: `无法读取此用户的登录凭据：${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  deleteAccountRecord(accountId: string): boolean {
    const prefs = readDesktopPrefsFile();
    const accounts = this.readStoredAccounts(prefs);
    const remaining = accounts.filter(
      (item) => !item.user || this.accountId(item.providerId || '', item.user) !== accountId,
    );
    if (remaining.length === accounts.length) return false;
    prefs[ACCOUNTS_KEY] = remaining;
    delete prefs[LEGACY_SESSION_KEY];
    if (prefs[ACTIVE_ACCOUNT_KEY] === accountId) delete prefs[ACTIVE_ACCOUNT_KEY];
    writeDesktopPrefsFile(prefs);
    if (this.activeAccountId === accountId) {
      this.activeAccountId = '';
      this.cookie = '';
      this.user = null;
    }
    return true;
  }

  cookieHeader(): string {
    return this.mode === 'remote' || this.mode === 'email' ? this.cookie : '';
  }

  private restoreRemoteSession(): void {
    this.cookie = '';
    this.user = null;
    const prefs = readDesktopPrefsFile();
    const accounts = this.readStoredAccounts(prefs);
    const activeId = typeof prefs[ACTIVE_ACCOUNT_KEY] === 'string' ? prefs[ACTIVE_ACCOUNT_KEY] : '';
    const stored = accounts.find(
      (item) => item.providerId === this.providerId && item.user
        && this.accountId(item.providerId || '', item.user) === activeId,
    ) || accounts.find((item) => item.providerId === this.providerId && item.user);
    const user = normalizedUser(stored?.user);
    this.activeAccountId = stored && user ? this.accountId(this.providerId, user) : '';
    if (!stored?.encryptedCookie || !user || !safeStorage.isEncryptionAvailable()) return;
    try {
      const cookie = safeStorage.decryptString(Buffer.from(stored.encryptedCookie, 'base64'));
      if (!cookie.startsWith(`${SESSION_COOKIE_NAME}=`)) return;
      this.cookie = cookie;
      this.user = user;
    } catch {
      this.clearPersistedSession();
    }
  }

  private persistRemoteSession(): void {
    if (!this.cookie || !this.user) return;
    const prefs = readDesktopPrefsFile();
    const accounts = this.readStoredAccounts(prefs);
    const accountId = this.accountId(this.providerId, this.user);
    const encryptedCookie = safeStorage.isEncryptionAvailable()
      ? safeStorage.encryptString(this.cookie).toString('base64')
      : undefined;
    const stored: StoredAuthSession = {
      providerId: this.providerId,
      ...(encryptedCookie ? { encryptedCookie } : {}),
      user: this.user,
      lastUsedAt: Date.now(),
    };
    const nextAccounts = [
      stored,
      ...accounts.filter((item) => !item.user || this.accountId(item.providerId || '', item.user) !== accountId),
    ];
    this.activeAccountId = accountId;
    delete prefs[LEGACY_SESSION_KEY];
    writeDesktopPrefsFile({
      ...prefs,
      [ACCOUNTS_KEY]: nextAccounts,
      [ACTIVE_ACCOUNT_KEY]: accountId,
    });
  }

  private clearPersistedSession(): void {
    const prefs = readDesktopPrefsFile();
    const accountId = this.activeAccountId || this.currentAccountId();
    const accounts = this.readStoredAccounts(prefs).map((account) => {
      if (!account.user || this.accountId(account.providerId || '', account.user) !== accountId) return account;
      const { encryptedCookie: _encryptedCookie, ...withoutCookie } = account;
      return withoutCookie;
    });
    prefs[ACCOUNTS_KEY] = accounts;
    delete prefs[LEGACY_SESSION_KEY];
    delete prefs[ACTIVE_ACCOUNT_KEY];
    writeDesktopPrefsFile(prefs);
    this.activeAccountId = '';
  }

  private readStoredAccounts(prefs = readDesktopPrefsFile()): StoredAuthSession[] {
    const raw = prefs[ACCOUNTS_KEY];
    const accounts: StoredAuthSession[] = [];
    if (Array.isArray(raw)) {
      for (const item of raw) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
        const record = item as StoredAuthSession;
        const user = normalizedUser(record.user);
        if (!user || typeof record.providerId !== 'string') continue;
        accounts.push({
          providerId: record.providerId,
          ...(typeof record.encryptedCookie === 'string' ? { encryptedCookie: record.encryptedCookie } : {}),
          user,
          ...(typeof record.lastUsedAt === 'number' && Number.isFinite(record.lastUsedAt)
            ? { lastUsedAt: record.lastUsedAt }
            : {}),
        });
      }
    }
    if (accounts.length > 0) return accounts;
    const legacy = prefs[LEGACY_SESSION_KEY] as StoredAuthSession | undefined;
    return legacy?.providerId && normalizedUser(legacy.user) ? [legacy] : [];
  }

  private accountId(providerId: string, user: AuthUserSnapshot): string {
    return `${providerId}:${user.userId}`;
  }

  private currentAccountId(): string {
    return this.activeAccountId || (this.user ? this.accountId(this.providerId, this.user) : '');
  }

  private touchStoredAccount(accountId: string): void {
    const prefs = readDesktopPrefsFile();
    const accounts = this.readStoredAccounts(prefs).map((account) => {
      if (!account.user || this.accountId(account.providerId || '', account.user) !== accountId) return account;
      return { ...account, lastUsedAt: Date.now() };
    });
    delete prefs[LEGACY_SESSION_KEY];
    writeDesktopPrefsFile({
      ...prefs,
      [ACCOUNTS_KEY]: accounts,
      [ACTIVE_ACCOUNT_KEY]: accountId,
    });
  }

  async sendCode(baseUrl: string, phoneNumber: string): Promise<Record<string, unknown>> {
    const response = await fetch(this.endpoint(baseUrl, '/api/auth/send-code'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phoneNumber }),
      redirect: 'error',
    });
    const payload = parseJson(await response.text());
    return { ...payload, ok: response.ok && payload.ok === true, status: response.status };
  }

  async login(
    baseUrl: string,
    phoneNumber: string,
    code: string,
  ): Promise<Record<string, unknown>> {
    const response = await fetch(this.endpoint(baseUrl, '/api/auth/login'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phoneNumber, code }),
      redirect: 'error',
    });
    const payload = parseJson(await response.text());
    const user = normalizedUser(payload.user);
    const cookie = cookiePair(response.headers.get('set-cookie'));
    if (!response.ok || payload.ok !== true || !user || !cookie) {
      return { ...payload, ok: false, status: response.status };
    }
    this.cookie = cookie;
    this.user = user;
    this.persistRemoteSession();
    return { ok: true, status: response.status, user };
  }

  async loginWithEmail(baseUrl: string, email: string): Promise<Record<string, unknown>> {
    const response = await fetch(this.endpoint(baseUrl, '/api/auth/login'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
      redirect: 'error',
    });
    const payload = parseJson(await response.text());
    const user = normalizedUser(payload.user);
    const cookie = cookiePair(response.headers.get('set-cookie'));
    if (!response.ok || payload.ok !== true || !user || !cookie) {
      return { ...payload, ok: false, status: response.status };
    }
    this.cookie = cookie;
    this.user = user;
    this.persistRemoteSession();
    const verified = await this.refreshConfig(baseUrl);
    if (!verified.isLoggedIn) {
      return { ok: false, status: 401, error: '邮箱会话验证失败，请重试' };
    }
    return { ok: true, status: response.status, user: verified.user };
  }

  async logout(baseUrl: string): Promise<Record<string, unknown>> {
    if ((this.mode !== 'remote' && this.mode !== 'email') || !this.cookie) {
      this.cookie = '';
      this.user = null;
      this.clearPersistedSession();
      return { ok: true, released: true };
    }
    const response = await fetch(this.endpoint(baseUrl, '/api/auth/logout'), {
      method: 'POST',
      headers: { Cookie: this.cookie },
      redirect: 'error',
    });
    const payload = parseJson(await response.text());
    if (!response.ok || payload.ok !== true) {
      return { ...payload, ok: false, status: response.status };
    }
    this.cookie = '';
    this.user = null;
    this.clearPersistedSession();
    return { ...payload, ok: true, status: response.status };
  }

  async logoutAccount(baseUrl: string, accountId: string): Promise<Record<string, unknown>> {
    const account = this.readStoredAccounts().find(
      (item) => item.user && this.accountId(item.providerId || '', item.user) === accountId,
    );
    if (!account) return { ok: false, error: '找不到此登录用户记录。' };
    if (!account.encryptedCookie) return { ok: true, released: true };
    if (!safeStorage.isEncryptionAvailable()) {
      return { ok: false, error: '当前系统无法解密此用户的登录凭据。' };
    }

    let cookie: string;
    try {
      cookie = safeStorage.decryptString(Buffer.from(account.encryptedCookie, 'base64'));
    } catch (error) {
      return {
        ok: false,
        error: `无法读取此用户的登录凭据：${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (!cookie.startsWith(`${SESSION_COOKIE_NAME}=`)) {
      return { ok: false, error: '此用户的登录凭据无效。' };
    }

    const response = await fetch(this.endpoint(baseUrl, '/api/auth/logout'), {
      method: 'POST',
      headers: { Cookie: cookie },
      redirect: 'error',
    });
    const payload = parseJson(await response.text());
    if (!response.ok || payload.ok !== true) {
      return { ...payload, ok: false, status: response.status };
    }
    return { ...payload, ok: true, status: response.status };
  }
}

export const desktopAuthSession = new DesktopAuthSession();

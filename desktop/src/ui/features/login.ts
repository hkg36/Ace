/** Login wall and account settings for local email and remote authentication. */

import type { AuthAccountSnapshot, AuthStateSnapshot } from '../../shared/types';
import { notify, type UserInfo } from '../state';
import { authStore } from '../stores/auth-store';

let currentState: AuthStateSnapshot = {
  mode: 'unknown',
  configured: false,
  providerId: 'custom',
  isLoggedIn: false,
  user: null,
};
let bound = false;
let countdownTimer: number | null = null;
let accountListGeneration = 0;

function message(text: string, kind: 'error' | 'success' | 'info' = 'info'): void {
  const element = document.getElementById('login-message');
  if (!element) return;
  element.textContent = text;
  element.className = `login-message login-message--${kind}`;
  element.hidden = !text;
}

function setBusy(busy: boolean): void {
  const submit = document.getElementById('login-submit') as HTMLButtonElement | null;
  const code = document.getElementById('login-get-code') as HTMLButtonElement | null;
  if (submit) submit.disabled = busy;
  if (code && countdownTimer === null) code.disabled = busy;
}

function showLoginWall(show: boolean): void {
  document.body.classList.toggle('auth-wall-active', show);
  const modal = document.getElementById('login-modal');
  if (modal) {
    modal.hidden = !show;
    if (show) {
      queueMicrotask(() => (document.getElementById('login-phone') as HTMLInputElement | null)?.focus());
    }
  }
}

/** Keep the old renderer consumers working while AuthStateSnapshot is canonical. */
function legacyUserInfo(state: AuthStateSnapshot): UserInfo | null {
  if (!state.isLoggedIn) return null;
  const user = state.user;
  if (!user) {
    if (state.mode === 'dev') return { staffCode: 'dev:dev', staffName: '开发账号' };
    if (state.mode === 'local') return { staffCode: 'local', staffName: '本地账号' };
    return null;
  }
  const accountId = state.mode === 'remote' || state.mode === 'email'
    ? `${state.providerId}:${user.userId}`
    : state.mode === 'dev' ? 'dev:dev' : 'local';
  const name = user.displayName || user.email || user.phoneNumber || user.userId;
  return {
    staffCode: accountId,
    staffUid: user.userId,
    uid: user.userId,
    staffName: name,
  };
}

function syncRendererAuth(state: AuthStateSnapshot): void {
  const next = { isLoggedIn: state.isLoggedIn, userInfo: legacyUserInfo(state) };
  const previous = authStore.get();
  if (
    previous.isLoggedIn !== next.isLoggedIn
    || previous.userInfo?.staffCode !== next.userInfo?.staffCode
    || previous.userInfo?.staffUid !== next.userInfo?.staffUid
    || previous.userInfo?.staffName !== next.userInfo?.staffName
  ) {
    authStore.replace(next);
  }
}

function displayValue(id: string, value: string): void {
  const element = document.getElementById(id);
  if (!element) return;
  element.textContent = value || '-';
  element.classList.toggle('is-empty', !value);
}

function accountName(account: AuthAccountSnapshot): string {
  const user = account.user;
  return user.displayName || user.email || user.phoneNumber || user.userId;
}

function closeAccountMenu(): void {
  const menu = document.getElementById('user-account-menu');
  const trigger = document.querySelector('[data-user-account-trigger]');
  if (menu) menu.hidden = true;
  trigger?.setAttribute('aria-expanded', 'false');
}

function makeAccountMenuItem(account: AuthAccountSnapshot): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'mw-app-account__menu-item';
  button.setAttribute('role', 'menuitem');
  button.setAttribute('aria-current', String(account.isCurrent));
  button.disabled = account.isCurrent || !account.canSwitch;

  const avatar = document.createElement('span');
  avatar.className = 'mw-app-account__menu-avatar';
  avatar.textContent = Array.from(accountName(account))[0] || '我';
  const copy = document.createElement('span');
  copy.className = 'mw-app-account__menu-copy';
  const name = document.createElement('span');
  name.className = 'mw-app-account__menu-name';
  name.textContent = accountName(account);
  const contact = document.createElement('span');
  contact.className = 'mw-app-account__menu-contact';
  contact.textContent = account.user.email || account.user.phoneNumber || account.user.userId;
  copy.append(name, contact);
  button.append(avatar, copy);
  if (account.isCurrent) {
    const current = document.createElement('span');
    current.className = 'mw-app-account__menu-current';
    current.textContent = '当前';
    button.append(current);
  } else if (!account.canSwitch) {
    const unavailable = document.createElement('span');
    unavailable.className = 'mw-app-account__menu-current';
    unavailable.textContent = '需重新登录';
    button.append(unavailable);
  }
  if (account.canSwitch && !account.isCurrent) {
    button.addEventListener('click', () => {
      closeAccountMenu();
      void window.Crew.authSwitchAccount(account.accountId)
        .then((result) => {
          if (result.ok !== true) {
            notify(responseError(result, '切换用户失败。'));
            return;
          }
          window.location.reload();
        })
        .catch((error) => notify(`切换用户失败：${(error as Error).message}`));
    });
  }
  return button;
}

function deleteAccount(account: AuthAccountSnapshot, button?: HTMLButtonElement): void {
  const name = accountName(account);
  const confirmed = window.confirm(
    `确定删除“${name}”的登录记录和账号数据文件夹吗？此操作会永久删除该用户的会话、记忆和本地文件。`,
  );
  if (!confirmed) return;
  if (button) button.disabled = true;
  void window.Crew.authDeleteAccount(account.accountId)
    .then((result) => {
      if (result.ok !== true) {
        notify(responseError(result, '删除用户记录和数据失败。'));
        if (button) button.disabled = false;
        return;
      }
      const warning = typeof result.warning === 'string' ? result.warning : '';
      if (account.isCurrent) {
        if (warning) {
          notify(warning);
          window.setTimeout(() => window.location.reload(), 1200);
        } else {
          window.location.reload();
        }
        return;
      }
      notify(warning || `已删除用户“${name}”的登录记录和数据。`);
      void refreshAccountList();
    })
    .catch((error) => {
      notify(`删除用户失败：${(error as Error).message}`);
      if (button) button.disabled = false;
    });
}

function renderAccountList(accounts: AuthAccountSnapshot[]): void {
  const menu = document.getElementById('user-account-menu');
  if (menu) {
    const title = document.createElement('div');
    title.className = 'mw-app-account__menu-title';
    title.textContent = '切换登录用户';
    menu.replaceChildren(title);
    if (accounts.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'mw-app-account__menu-title';
      empty.textContent = '暂无登录记录';
      menu.append(empty);
    } else {
      for (const account of accounts) menu.append(makeAccountMenuItem(account));
    }
    const footer = document.createElement('div');
    footer.className = 'mw-app-account__menu-footer';
    const settings = document.createElement('button');
    settings.type = 'button';
    settings.className = 'mw-app-account__menu-settings';
    settings.setAttribute('role', 'menuitem');
    settings.textContent = '账户管理…';
    settings.addEventListener('click', () => {
      closeAccountMenu();
      window.dispatchEvent(new CustomEvent('user:open-account'));
    });
    footer.append(settings);
    menu.append(footer);
  }

  const list = document.getElementById('set-account-history-list');
  if (!list) return;
  list.replaceChildren();
  if (accounts.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'set-account-history__empty';
    empty.textContent = '尚无登录用户记录。';
    list.append(empty);
    return;
  }
  for (const account of accounts) {
    const row = document.createElement('div');
    row.className = 'set-account-history__item';
    const identity = document.createElement('div');
    identity.className = 'set-account-history__identity';
    const avatar = document.createElement('span');
    avatar.className = 'set-account-history__avatar';
    avatar.textContent = Array.from(accountName(account))[0] || '我';
    const copy = document.createElement('span');
    copy.className = 'set-account-history__copy';
    const name = document.createElement('span');
    name.className = 'set-account-history__name';
    name.textContent = accountName(account);
    const contact = document.createElement('span');
    contact.className = 'set-account-history__contact';
    contact.textContent = account.user.email || account.user.phoneNumber || account.user.userId;
    copy.append(name, contact);
    identity.append(avatar, copy);

    const actions = document.createElement('div');
    actions.className = 'set-account-history__actions';
    if (account.isCurrent) {
      const current = document.createElement('span');
      current.className = 'set-account-history__current';
      current.textContent = '当前用户';
      actions.append(current);
    } else {
      const switchButton = document.createElement('button');
      switchButton.type = 'button';
      switchButton.className = 'set-v2-btn';
      switchButton.textContent = account.canSwitch ? '切换' : '需重新登录';
      switchButton.disabled = !account.canSwitch;
      if (account.canSwitch) {
        switchButton.addEventListener('click', () => {
          void window.Crew.authSwitchAccount(account.accountId)
            .then((result) => {
              if (result.ok !== true) {
                notify(responseError(result, '切换用户失败。'));
                return;
              }
              window.location.reload();
            })
            .catch((error) => notify(`切换用户失败：${(error as Error).message}`));
        });
      }
      actions.append(switchButton);
    }
    const removeButton = document.createElement('button');
    removeButton.type = 'button';
    removeButton.className = 'set-v2-btn set-v2-btn--danger';
    removeButton.textContent = '删除';
    removeButton.addEventListener('click', () => deleteAccount(account, removeButton));
    actions.append(removeButton);
    row.append(identity, actions);
    list.append(row);
  }
}

async function refreshAccountList(): Promise<void> {
  const generation = ++accountListGeneration;
  try {
    const accounts = await window.Crew.authListAccounts();
    if (generation === accountListGeneration) renderAccountList(accounts);
  } catch (error) {
    if (generation === accountListGeneration) {
      notify(`读取登录用户列表失败：${(error as Error).message}`);
    }
  }
}

function renderAccount(): void {
  const loggedIn = document.getElementById('set-account-logged-in');
  const loggedOut = document.getElementById('set-account-logged-out');
  const user = currentState.user;
  const visibleUser = currentState.isLoggedIn && user;
  const navAvatar = document.querySelector('[data-user-avatar]');
  const navName = document.querySelector('[data-user-name]');
  if (loggedIn) loggedIn.hidden = !visibleUser;
  if (loggedOut) loggedOut.hidden = Boolean(visibleUser);
  if (visibleUser) {
    const name = user.displayName || user.email || user.phoneNumber || user.userId;
    if (navAvatar) navAvatar.textContent = Array.from(name)[0] || '我';
    if (navName) navName.textContent = name;
    displayValue('set-account-name', name);
    displayValue('set-account-provider', currentState.mode === 'email' ? '本机邮箱租户' : currentState.mode === 'remote' ? currentState.providerId : '本机模式');
    displayValue('set-account-user-id', user.userId);
    displayValue('set-account-phone', user.email || user.phoneNumber);
    const contactLabel = document.getElementById('set-account-contact-label');
    if (contactLabel) contactLabel.textContent = currentState.mode === 'email' ? '邮箱' : '手机号';
    const avatar = document.getElementById('set-account-avatar');
    if (avatar) avatar.textContent = Array.from(name)[0] || '我';
    const removeAccount = document.getElementById('set-account-logout') as HTMLButtonElement | null;
    if (removeAccount) removeAccount.hidden = currentState.mode !== 'remote' && currentState.mode !== 'email';
    return;
  }
  if (currentState.isLoggedIn) {
    const localName = currentState.mode === 'dev' ? '开发账号' : '本地账号';
    if (navAvatar) navAvatar.textContent = Array.from(localName)[0] || '我';
    if (navName) navName.textContent = localName;
  } else {
    if (navAvatar) navAvatar.textContent = '我';
    if (navName) navName.textContent = '未登录';
  }
  const removeAccount = document.getElementById('set-account-logout') as HTMLButtonElement | null;
  if (removeAccount) removeAccount.hidden = true;
  const title = document.getElementById('set-account-empty-title');
  const description = document.getElementById('set-account-empty-desc');
  const login = document.getElementById('set-account-go-login') as HTMLButtonElement | null;
  if (title) title.textContent = currentState.configured ? '尚未登录' : '认证服务未配置';
  if (description) {
    description.textContent = currentState.configured
      ? '登录后，会话、模型配置和 Wiki 数据将按用户隔离。'
      : '请配置 auth.remote.base_url 或 CREW_AUTH_BASE_URL 后重启。';
  }
  if (login) login.hidden = !['remote', 'email'].includes(currentState.mode) || !currentState.configured;
}

function renderLoginMode(): void {
  const isEmail = currentState.mode === 'email';
  const title = document.getElementById('login-title');
  const label = document.getElementById('login-identifier-label');
  const input = document.getElementById('login-phone') as HTMLInputElement | null;
  const codeGroup = document.getElementById('login-code-group');
  const submit = document.getElementById('login-submit');
  if (title) title.textContent = isEmail ? '使用邮箱进入 Ace' : '登录 Ace';
  if (label) label.textContent = isEmail ? '邮箱' : '手机号';
  if (input) {
    input.type = isEmail ? 'email' : 'tel';
    input.placeholder = isEmail ? '请输入邮箱' : '请输入手机号';
    input.autocomplete = isEmail ? 'email' : 'tel';
    input.maxLength = isEmail ? 128 : 32;
  }
  if (codeGroup) codeGroup.hidden = isEmail;
  if (submit) submit.textContent = isEmail ? '进入 Ace' : '登录';
}

function applyState(state: AuthStateSnapshot): void {
  currentState = state;
  syncRendererAuth(state);
  renderLoginMode();
  renderAccount();
  void refreshAccountList();
  const needsLogin = (state.mode === 'remote' || state.mode === 'email') && !state.isLoggedIn;
  showLoginWall(needsLogin);
  if (needsLogin && !state.configured) {
    message('远程认证已启用，但认证服务地址尚未配置。', 'error');
  }
}

function startCountdown(seconds = 60): void {
  const button = document.getElementById('login-get-code') as HTMLButtonElement | null;
  if (!button) return;
  if (countdownTimer !== null) window.clearInterval(countdownTimer);
  let remaining = seconds;
  button.disabled = true;
  button.textContent = `${remaining}s`;
  countdownTimer = window.setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) {
      if (countdownTimer !== null) window.clearInterval(countdownTimer);
      countdownTimer = null;
      button.disabled = false;
      button.textContent = '获取验证码';
      return;
    }
    button.textContent = `${remaining}s`;
  }, 1000);
}

function responseError(result: Record<string, unknown>, fallback: string): string {
  return typeof result.error === 'string' && result.error.trim() ? result.error : fallback;
}

function bind(): void {
  if (bound) return;
  bound = true;
  document.getElementById('login-get-code')?.addEventListener('click', () => {
    const phone = (document.getElementById('login-phone') as HTMLInputElement | null)?.value.trim() || '';
    if (!phone) {
      message('请输入手机号。', 'error');
      return;
    }
    setBusy(true);
    void window.Crew.authSendCode(phone)
      .then((result) => {
        if (result.ok !== true) {
          message(responseError(result, '验证码发送失败。'), 'error');
          return;
        }
        message(typeof result.message === 'string' ? result.message : '验证码已发送。', 'success');
        startCountdown();
      })
      .catch((error) => message((error as Error).message || '验证码发送失败。', 'error'))
      .finally(() => setBusy(false));
  });

  const submit = (): void => {
    const identifier = (document.getElementById('login-phone') as HTMLInputElement | null)?.value.trim() || '';
    const code = (document.getElementById('login-code') as HTMLInputElement | null)?.value.trim() || '';
    if (!identifier || (currentState.mode === 'remote' && !code)) {
      message(currentState.mode === 'email' ? '请输入邮箱。' : '请输入手机号和验证码。', 'error');
      return;
    }
    setBusy(true);
    message('正在登录…', 'info');
    void window.Crew.authLogin(identifier, code)
      .then((result) => {
        if (result.ok !== true) {
          message(responseError(result, '登录失败。'), 'error');
          return;
        }
        message('登录成功，正在加载账号数据…', 'success');
        window.setTimeout(() => window.location.reload(), 80);
      })
      .catch((error) => message((error as Error).message || '登录失败。', 'error'))
      .finally(() => setBusy(false));
  };
  document.getElementById('login-submit')?.addEventListener('click', submit);
  const submitOnEnter = (event: Event): void => {
    if ((event as KeyboardEvent).key === 'Enter') submit();
  };
  document.getElementById('login-phone')?.addEventListener('keydown', submitOnEnter);
  document.getElementById('login-code')?.addEventListener('keydown', submitOnEnter);
  document.getElementById('login-quit')?.addEventListener('click', () => void window.Crew.appQuit());
  document.getElementById('set-account-go-login')?.addEventListener('click', () => showLoginWall(true));
  document.querySelector('[data-user-account-trigger]')?.addEventListener('click', () => {
    const menu = document.getElementById('user-account-menu');
    const trigger = document.querySelector('[data-user-account-trigger]');
    if (!menu) {
      window.dispatchEvent(new CustomEvent('user:open-account'));
      return;
    }
    menu.hidden = !menu.hidden;
    trigger?.setAttribute('aria-expanded', String(!menu.hidden));
  });
  document.addEventListener('click', (event) => {
    const accountSection = document.getElementById('user-section');
    if (accountSection && !accountSection.contains(event.target as Node)) closeAccountMenu();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeAccountMenu();
  });
  document.getElementById('set-account-logout')?.addEventListener('click', () => {
    const currentAccount = currentState.user && (currentState.mode === 'remote' || currentState.mode === 'email')
      ? {
          accountId: `${currentState.providerId}:${currentState.user.userId}`,
          providerId: currentState.providerId,
          user: currentState.user,
          isCurrent: true,
          lastUsedAt: Date.now(),
          canSwitch: true,
        } satisfies AuthAccountSnapshot
      : null;
    if (currentAccount) deleteAccount(currentAccount);
  });
  window.Crew.onSessionState((state) => applyState(state));
}

export async function initAuthFlow(): Promise<boolean> {
  bind();
  const result = await window.Crew.authGetState();
  if (result.ok && result.state) {
    applyState(result.state);
  } else if (!result.ok) {
    applyState({
      mode: 'unknown',
      configured: false,
      providerId: 'custom',
      isLoggedIn: false,
      user: null,
    });
  }
  await window.Crew.rendererInitialStateReady();
  return result.ok ? result.state.isLoggedIn : false;
}

export function renderAuthAccount(): void {
  renderAccount();
  void refreshAccountList();
}

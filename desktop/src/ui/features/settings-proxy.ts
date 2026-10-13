import { backendApi } from '../backend-client';
import { notify } from '../state';

let initialized = false;

function field(labelText: string, input: HTMLInputElement): HTMLElement {
  const label = document.createElement('label');
  const title = document.createElement('span');
  label.className = 'mw-field';
  title.className = 'mw-field__label';
  title.textContent = labelText;
  input.className = 'mw-field__control mw-field__control--large';
  label.append(title, input);
  return label;
}

export function mountBrowserProxyPane(): void {
  const pane = document.getElementById('settings-pane-proxy');
  if (!pane || initialized) return;
  initialized = true;

  const shell = document.createElement('section');
  const header = document.createElement('header');
  const title = document.createElement('h1');
  const description = document.createElement('p');
  const body = document.createElement('div');
  const server = document.createElement('input');
  const username = document.createElement('input');
  const password = document.createElement('input');
  const help = document.createElement('p');
  const status = document.createElement('p');
  const save = document.createElement('button');

  shell.className = 'settings-data';
  header.className = 'settings-data__header';
  title.className = 'settings-data__title';
  title.textContent = '内置浏览器代理';
  description.className = 'settings-data__description';
  description.textContent = '为内置浏览器设置上游 HTTP/HTTPS 代理。不会影响模型 API 或其他网络请求。';
  body.className = 'settings-data__body settings-proxy-form';
  server.type = 'url';
  server.placeholder = 'http://127.0.0.1:7890';
  server.autocomplete = 'off';
  server.setAttribute('aria-label', '代理服务器地址');
  username.type = 'text';
  username.autocomplete = 'username';
  username.setAttribute('aria-label', '代理用户名');
  password.type = 'password';
  password.autocomplete = 'new-password';
  password.placeholder = '留空则保留已保存的密码';
  password.setAttribute('aria-label', '代理密码');
  help.className = 'settings-data__description';
  help.textContent = '留空代理地址可关闭代理。支持 HTTP 和 HTTPS 代理地址；目标地址仍会经过浏览器网络策略校验。代理认证信息保存在本机配置中；使用 HTTPS 代理可加密到代理服务器的连接。';
  status.className = 'settings-proxy-status';
  status.setAttribute('role', 'status');
  save.type = 'button';
  save.className = 'mw-button mw-button--primary mw-button--default';
  save.textContent = '保存代理设置';
  body.append(
    field('代理服务器地址', server),
    field('用户名（可选）', username),
    field('密码（可选）', password),
    help,
    status,
    save,
  );
  header.append(title, description);
  shell.append(header, body);
  pane.replaceChildren(shell);

  save.addEventListener('click', () => {
    void (async () => {
      save.disabled = true;
      status.textContent = '正在保存…';
      status.dataset.tone = '';
      try {
        const result = await backendApi.saveBrowserProxy({
          server: server.value.trim(),
          username: username.value.trim(),
          password: password.value,
        });
        server.value = result.server;
        username.value = result.username;
        password.value = '';
        password.placeholder = result.has_password
          ? '已保存密码；留空可保留'
          : '输入代理密码';
        status.textContent = '代理设置已保存；新请求将使用此配置。';
        status.dataset.tone = 'success';
        notify('内置浏览器代理设置已保存');
      } catch (error) {
        status.textContent = `保存失败：${error instanceof Error ? error.message : String(error)}`;
        status.dataset.tone = 'danger';
      } finally {
        save.disabled = false;
      }
    })();
  });
}

export async function renderBrowserProxyPane(): Promise<void> {
  mountBrowserProxyPane();
  const pane = document.getElementById('settings-pane-proxy');
  const server = pane?.querySelector<HTMLInputElement>('input[aria-label="代理服务器地址"]');
  const username = pane?.querySelector<HTMLInputElement>('input[aria-label="代理用户名"]');
  const password = pane?.querySelector<HTMLInputElement>('input[aria-label="代理密码"]');
  const status = pane?.querySelector<HTMLElement>('.settings-proxy-status');
  if (!server || !username || !password || !status) return;
  status.textContent = '正在读取代理设置…';
  status.dataset.tone = '';
  try {
    const settings = await backendApi.browserProxy();
    server.value = settings.server;
    username.value = settings.username;
    password.value = '';
    password.placeholder = settings.has_password
      ? '已保存密码；留空可保留'
      : '输入代理密码';
    status.textContent = settings.server
      ? '已配置浏览器上游代理。'
      : '尚未配置浏览器代理。';
  } catch (error) {
    status.textContent = `读取失败：${error instanceof Error ? error.message : String(error)}`;
    status.dataset.tone = 'danger';
  }
}

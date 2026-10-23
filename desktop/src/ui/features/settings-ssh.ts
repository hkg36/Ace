import { notify } from '../state';
import type {
  SshAuthType,
  SshConnectionInput,
  SshConnectionSummary,
} from '../../shared/ssh-config';

let initialized = false;
let configs: SshConnectionSummary[] = [];
let editingId: string | null = null;
let reloadConfigs: (() => Promise<void>) | null = null;

function makeField(labelText: string, input: HTMLElement): HTMLElement {
  const label = document.createElement('label');
  const title = document.createElement('span');
  label.className = 'mw-field';
  title.className = 'mw-field__label';
  title.textContent = labelText;
  input.classList.add('mw-field__control', 'mw-field__control--large');
  label.append(title, input);
  return label;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function mountSshSettingsPane(): Promise<void> {
  const pane = document.getElementById('settings-pane-ssh');
  if (!pane) return;
  if (initialized) {
    await reloadConfigs?.();
    return;
  }
  initialized = true;

  const shell = document.createElement('section');
  const header = document.createElement('header');
  const title = document.createElement('h1');
  const description = document.createElement('p');
  const toolbar = document.createElement('div');
  const addButton = document.createElement('button');
  const status = document.createElement('p');
  const list = document.createElement('div');
  const form = document.createElement('section');
  const formTitle = document.createElement('h2');
  const fields = document.createElement('div');
  const name = document.createElement('input');
  const host = document.createElement('input');
  const port = document.createElement('input');
  const username = document.createElement('input');
  const authType = document.createElement('select');
  const password = document.createElement('input');
  const keyPath = document.createElement('input');
  const browseKey = document.createElement('button');
  const keyPathRow = document.createElement('div');
  const passwordField = makeField('密码', password);
  const keyPathField = document.createElement('div');
  const keyPathLabel = document.createElement('span');
  const formStatus = document.createElement('p');
  const saveButton = document.createElement('button');
  const testButton = document.createElement('button');
  const cancelButton = document.createElement('button');

  shell.className = 'settings-data';
  header.className = 'settings-data__header';
  title.className = 'settings-data__title';
  title.textContent = 'SSH 连接配置';
  description.className = 'settings-data__description';
  description.textContent = '管理多个 SSH 服务器配置，并测试服务器认证连接。密码使用系统安全存储加密保存在本机。';
  header.append(title, description);
  toolbar.className = 'settings-ssh__toolbar';
  addButton.type = 'button';
  addButton.className = 'mw-button mw-button--primary mw-button--default';
  addButton.textContent = '添加 SSH 配置';
  toolbar.append(addButton);
  status.className = 'settings-ssh__status';
  status.setAttribute('role', 'status');
  list.className = 'settings-ssh__list';

  form.className = 'settings-ssh__form';
  form.hidden = true;
  formTitle.className = 'settings-data__title';
  formTitle.textContent = '新增配置';
  fields.className = 'settings-ssh__fields';
  name.type = 'text';
  name.maxLength = 100;
  name.autocomplete = 'off';
  name.setAttribute('aria-label', '配置名称');
  host.type = 'text';
  host.maxLength = 255;
  host.autocomplete = 'off';
  host.placeholder = '例如 192.168.1.10 或 server.example.com';
  host.setAttribute('aria-label', '服务器地址');
  port.type = 'number';
  port.min = '1';
  port.max = '65535';
  port.step = '1';
  port.value = '22';
  port.setAttribute('aria-label', '服务器端口');
  username.type = 'text';
  username.maxLength = 128;
  username.autocomplete = 'username';
  username.value = 'root';
  username.setAttribute('aria-label', '登入用户名');
  authType.className = 'mw-field__control mw-field__control--large';
  authType.setAttribute('aria-label', 'SSH 认证方式');
  for (const optionData of [
    { value: 'password', label: '密码认证' },
    { value: 'privateKey', label: '私钥文件认证' },
  ]) {
    const option = document.createElement('option');
    option.value = optionData.value;
    option.textContent = optionData.label;
    authType.append(option);
  }
  password.type = 'password';
  password.autocomplete = 'new-password';
  password.setAttribute('aria-label', 'SSH 密码');
  keyPath.type = 'text';
  keyPath.autocomplete = 'off';
  keyPath.placeholder = '选择或输入私钥文件路径';
  keyPath.setAttribute('aria-label', '私钥文件路径');
  keyPathRow.className = 'settings-ssh__key-path';
  keyPathField.className = 'mw-field';
  keyPathLabel.className = 'mw-field__label';
  keyPathLabel.textContent = '证书私钥文件路径';
  browseKey.type = 'button';
  browseKey.className = 'mw-button mw-button--secondary mw-button--default';
  browseKey.textContent = '选择文件';
  keyPathRow.append(keyPath, browseKey);
  keyPathField.append(keyPathLabel, keyPathRow);
  fields.append(
    makeField('名称', name),
    makeField('服务器地址', host),
    makeField('服务器端口', port),
    makeField('登入用户名', username),
    makeField('认证方式', authType),
    passwordField,
    keyPathField,
  );
  formStatus.className = 'settings-ssh__status';
  formStatus.setAttribute('role', 'status');
  const actions = document.createElement('div');
  actions.className = 'settings-ssh__actions';
  saveButton.type = 'button';
  saveButton.className = 'mw-button mw-button--primary mw-button--default';
  saveButton.textContent = '保存配置';
  testButton.type = 'button';
  testButton.className = 'mw-button mw-button--secondary mw-button--default';
  testButton.textContent = '测试连接';
  cancelButton.type = 'button';
  cancelButton.className = 'mw-button mw-button--secondary mw-button--default';
  cancelButton.textContent = '取消';
  actions.append(saveButton, testButton, cancelButton);
  form.append(formTitle, fields, formStatus, actions);
  shell.append(header, toolbar, status, list, form);
  pane.replaceChildren(shell);

  const setStatus = (target: HTMLElement, message: string, tone = ''): void => {
    target.textContent = message;
    target.dataset.tone = tone;
  };

  const currentInput = (): SshConnectionInput => {
    const selectedAuthType = authType.value as SshAuthType;
    const input: SshConnectionInput = {
      id: editingId ?? crypto.randomUUID(),
      name: name.value.trim(),
      host: host.value.trim(),
      port: Number(port.value),
      username: username.value.trim(),
      authType: selectedAuthType,
    };
    if (selectedAuthType === 'password') input.password = password.value;
    else input.privateKeyPath = keyPath.value.trim();
    return input;
  };

  const renderList = (): void => {
    list.replaceChildren();
    if (configs.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'settings-data__description';
      empty.textContent = '还没有 SSH 配置，点击“添加 SSH 配置”开始。';
      list.append(empty);
      return;
    }
    for (const config of configs) {
      const card = document.createElement('article');
      const copy = document.createElement('div');
      const configName = document.createElement('strong');
      const details = document.createElement('p');
      const cardActions = document.createElement('div');
      card.className = 'settings-ssh__item';
      copy.className = 'settings-ssh__item-copy';
      configName.className = 'settings-ssh__item-name';
      configName.textContent = config.name;
      details.className = 'settings-ssh__item-details';
      details.textContent = `${config.username}@${config.host}:${config.port} · ${config.authType === 'password' ? '密码认证' : '私钥认证'}`;
      copy.append(configName, details);
      cardActions.className = 'settings-ssh__actions';
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'mw-button mw-button--secondary mw-button--small';
      edit.textContent = '编辑';
      edit.addEventListener('click', () => {
        editingId = config.id;
        name.value = config.name;
        host.value = config.host;
        port.value = String(config.port);
        username.value = config.username;
        authType.value = config.authType;
        password.value = '';
        password.placeholder = config.hasPassword ? '留空则保留已保存的密码' : '请输入 SSH 密码';
        keyPath.value = config.privateKeyPath ?? '';
        formTitle.textContent = '编辑配置';
        form.hidden = false;
        updateAuthFields();
        setStatus(formStatus, '');
        name.focus();
      });
      const test = document.createElement('button');
      test.type = 'button';
      test.className = 'mw-button mw-button--secondary mw-button--small';
      test.textContent = '测试';
      test.addEventListener('click', () => {
        editingId = config.id;
        name.value = config.name;
        host.value = config.host;
        port.value = String(config.port);
        username.value = config.username;
        authType.value = config.authType;
        password.value = '';
        keyPath.value = config.privateKeyPath ?? '';
        form.hidden = true;
        void runTest(test, config);
      });
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'mw-button mw-button--danger mw-button--small';
      remove.textContent = '删除';
      remove.addEventListener('click', () => {
        void (async () => {
          remove.disabled = true;
          try {
            await window.Crew.deleteSshConnection(config.id);
            configs = configs.filter((candidate) => candidate.id !== config.id);
            renderList();
            setStatus(status, `已删除 SSH 配置“${config.name}”。`, 'success');
          } catch (error) {
            remove.disabled = false;
            setStatus(status, `删除失败：${errorMessage(error)}`, 'danger');
          }
        })();
      });
      cardActions.append(edit, test, remove);
      card.append(copy, cardActions);
      list.append(card);
    }
  };

  function updateAuthFields(): void {
    const passwordAuth = authType.value === 'password';
    passwordField.hidden = !passwordAuth;
    keyPathField.hidden = passwordAuth;
    keyPathRow.hidden = passwordAuth;
    if (passwordAuth) fields.append(passwordField);
    else {
      fields.append(keyPathField);
    }
  }

  async function runTest(button: HTMLButtonElement, config?: SshConnectionSummary): Promise<void> {
    const targetStatus = config ? status : formStatus;
    button.disabled = true;
    setStatus(targetStatus, '正在测试 SSH 连接…');
    try {
      const result = await window.Crew.testSshConnection(currentInput());
      if (result.ok) {
        setStatus(targetStatus, 'SSH 认证连接成功。', 'success');
      } else {
        setStatus(targetStatus, `连接失败：${result.error ?? '未知错误'}`, 'danger');
      }
    } catch (error) {
      setStatus(targetStatus, `连接测试失败：${errorMessage(error)}`, 'danger');
    } finally {
      button.disabled = false;
    }
  }

  const resetForm = (): void => {
    editingId = null;
    name.value = '';
    host.value = '';
    port.value = '22';
    username.value = 'root';
    authType.value = 'password';
    password.value = '';
    password.placeholder = '请输入 SSH 密码';
    keyPath.value = '';
    formTitle.textContent = '新增配置';
    form.hidden = true;
    setStatus(formStatus, '');
    updateAuthFields();
  };

  addButton.addEventListener('click', () => {
    resetForm();
    form.hidden = false;
    name.focus();
  });
  authType.addEventListener('change', updateAuthFields);
  browseKey.addEventListener('click', () => {
    void (async () => {
      browseKey.disabled = true;
      try {
        const result = await window.Crew.selectFile({
          filters: [{ name: '所有文件', extensions: ['*'] }],
        });
        if (Array.isArray(result) && typeof result[0] === 'string') keyPath.value = result[0];
      } catch (error) {
        setStatus(formStatus, `选择私钥文件失败：${errorMessage(error)}`, 'danger');
      } finally {
        browseKey.disabled = false;
      }
    })();
  });
  saveButton.addEventListener('click', () => {
    void (async () => {
      saveButton.disabled = true;
      setStatus(formStatus, '正在保存 SSH 配置…');
      try {
        const saved = await window.Crew.saveSshConnection(currentInput());
        configs = [...configs.filter((config) => config.id !== saved.id), saved];
        renderList();
        resetForm();
        setStatus(status, `SSH 配置“${saved.name}”已保存。`, 'success');
        notify('SSH 配置已保存');
      } catch (error) {
        setStatus(formStatus, `保存失败：${errorMessage(error)}`, 'danger');
      } finally {
        saveButton.disabled = false;
      }
    })();
  });
  testButton.addEventListener('click', () => void runTest(testButton));
  cancelButton.addEventListener('click', resetForm);

  reloadConfigs = async () => {
    try {
      configs = await window.Crew.listSshConnections();
      renderList();
      setStatus(status, '');
    } catch (error) {
      setStatus(status, `读取 SSH 配置失败：${errorMessage(error)}`, 'danger');
    }
  };
  updateAuthFields();
  await reloadConfigs();
}

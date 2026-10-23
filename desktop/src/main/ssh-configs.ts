import { safeStorage } from 'electron';
import { Client, type ConnectConfig } from 'ssh2';
import * as fs from 'node:fs';
import {
  readDesktopPrefsFile,
  writeDesktopPrefsFile,
} from './desktop-prefs';
import type {
  SshAuthType,
  SshConnectionInput,
  SshConnectionSummary,
  SshConnectionTestResult,
} from '../shared/ssh-config';

interface StoredSshConnection {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authType: SshAuthType;
  privateKeyPath?: string;
  encryptedPassword?: string;
}

const SSH_KEY_MAX_BYTES = 1024 * 1024;
const SSH_CONNECT_TIMEOUT_MS = 20_000;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validationError(field: string): never {
  throw new Error(`SSH 配置参数无效：${field}`);
}

function requiredText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string') validationError(field);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || /[\0\r\n]/.test(normalized)) {
    validationError(field);
  }
  return normalized;
}

function parseInput(raw: unknown): SshConnectionInput {
  if (!isRecord(raw)) validationError('配置');
  const id = requiredText(raw.id, 'id', 64);
  if (!ID_PATTERN.test(id)) validationError('id');
  const name = requiredText(raw.name, '名称', 100);
  const host = requiredText(raw.host, '服务器地址', 255);
  const username = requiredText(raw.username, '用户名', 128);
  if (typeof raw.port !== 'number' || !Number.isInteger(raw.port) || raw.port < 1 || raw.port > 65535) {
    validationError('服务器端口');
  }
  if (raw.authType !== 'password' && raw.authType !== 'privateKey') validationError('认证方式');

  const input: SshConnectionInput = {
    id,
    name,
    host,
    port: raw.port,
    username,
    authType: raw.authType,
  };
  if (raw.authType === 'password') {
    if (raw.password !== undefined && typeof raw.password !== 'string') validationError('密码');
    if (typeof raw.password === 'string' && raw.password.length > 4096) validationError('密码');
    if (typeof raw.password === 'string') input.password = raw.password;
  } else {
    input.privateKeyPath = requiredText(raw.privateKeyPath, '私钥文件路径', 4096);
  }
  return input;
}

function readStoredConnections(): StoredSshConnection[] {
  const stored = readDesktopPrefsFile().sshConnections;
  if (stored === undefined) return [];
  if (!Array.isArray(stored)) throw new Error('已保存的 SSH 配置格式无效。');

  return stored.map((item, index) => {
    if (!isRecord(item)
      || typeof item.id !== 'string'
      || !ID_PATTERN.test(item.id)
      || typeof item.name !== 'string'
      || typeof item.host !== 'string'
      || typeof item.port !== 'number'
      || typeof item.username !== 'string'
      || (item.authType !== 'password' && item.authType !== 'privateKey')
      || (item.privateKeyPath !== undefined && typeof item.privateKeyPath !== 'string')
      || (item.encryptedPassword !== undefined && typeof item.encryptedPassword !== 'string')) {
      throw new Error(`已保存的第 ${index + 1} 个 SSH 配置格式无效。`);
    }
    const connection: StoredSshConnection = {
      id: item.id,
      name: item.name,
      host: item.host,
      port: item.port,
      username: item.username,
      authType: item.authType,
    };
    if (typeof item.privateKeyPath === 'string') connection.privateKeyPath = item.privateKeyPath;
    if (typeof item.encryptedPassword === 'string') connection.encryptedPassword = item.encryptedPassword;
    return connection;
  });
}

function summary(connection: StoredSshConnection): SshConnectionSummary {
  return {
    id: connection.id,
    name: connection.name,
    host: connection.host,
    port: connection.port,
    username: connection.username,
    authType: connection.authType,
    ...(connection.privateKeyPath ? { privateKeyPath: connection.privateKeyPath } : {}),
    hasPassword: Boolean(connection.encryptedPassword),
  };
}

function persistConnections(connections: StoredSshConnection[]): void {
  writeDesktopPrefsFile({
    ...readDesktopPrefsFile(),
    sshConnections: connections,
  });
}

export function listSshConnections(): SshConnectionSummary[] {
  return readStoredConnections().map(summary);
}

export function saveSshConnection(raw: unknown): SshConnectionSummary {
  const input = parseInput(raw);
  const connections = readStoredConnections();
  const previous = connections.find((connection) => connection.id === input.id);
  const next: StoredSshConnection = {
    id: input.id,
    name: input.name,
    host: input.host,
    port: input.port,
    username: input.username,
    authType: input.authType,
  };

  if (input.authType === 'password') {
    if (input.password) {
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error('系统安全存储不可用，无法安全保存 SSH 密码。');
      }
      next.encryptedPassword = safeStorage.encryptString(input.password).toString('base64');
    } else if (previous?.encryptedPassword) {
      next.encryptedPassword = previous.encryptedPassword;
    } else {
      throw new Error('请输入 SSH 密码。');
    }
  } else {
    const privateKeyPath = input.privateKeyPath;
    if (!privateKeyPath) validationError('私钥文件路径');
    next.privateKeyPath = privateKeyPath;
  }

  const updated = previous
    ? connections.map((connection) => connection.id === next.id ? next : connection)
    : [...connections, next];
  persistConnections(updated);
  return summary(next);
}

export function deleteSshConnection(rawId: unknown): void {
  if (typeof rawId !== 'string' || !ID_PATTERN.test(rawId)) validationError('id');
  const connections = readStoredConnections();
  persistConnections(connections.filter((connection) => connection.id !== rawId));
}

function resolvePassword(input: SshConnectionInput, stored: StoredSshConnection | undefined): string {
  if (input.password) return input.password;
  if (!stored?.encryptedPassword) throw new Error('请输入 SSH 密码。');
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('系统安全存储不可用，无法读取已保存的 SSH 密码。');
  }
  return safeStorage.decryptString(Buffer.from(stored.encryptedPassword, 'base64'));
}

function connect(config: ConnectConfig): Promise<void> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let settled = false;
    const timeout = setTimeout(() => finish(new Error('SSH 连接超时。')), SSH_CONNECT_TIMEOUT_MS);

    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      client.end();
      if (error) reject(error);
      else resolve();
    };

    client.once('ready', () => finish());
    client.once('error', (error: Error) => finish(new Error(error.message)));
    client.once('close', () => {
      if (!settled) finish(new Error('SSH 连接已关闭，认证未完成。'));
    });
    client.connect({
      ...config,
      readyTimeout: SSH_CONNECT_TIMEOUT_MS - 2_000,
    });
  });
}

export async function testSshConnection(raw: unknown): Promise<SshConnectionTestResult> {
  const input = parseInput(raw);
  try {
    const stored = readStoredConnections().find((connection) => connection.id === input.id);
    const config: ConnectConfig = {
      host: input.host,
      port: input.port,
      username: input.username,
    };
    if (input.authType === 'password') {
      config.password = resolvePassword(input, stored);
    } else {
      const privateKeyPath = input.privateKeyPath;
      if (!privateKeyPath) throw new Error('请填写私钥文件路径。');
      const keyStat = fs.statSync(privateKeyPath);
      if (!keyStat.isFile() || keyStat.size > SSH_KEY_MAX_BYTES) {
        throw new Error('私钥文件无效或超过 1 MB。');
      }
      config.privateKey = fs.readFileSync(privateKeyPath);
    }
    await connect(config);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

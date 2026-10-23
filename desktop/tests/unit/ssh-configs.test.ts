import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  prefs: { sshConnections: [] as Record<string, unknown>[] },
  encryptionAvailable: true,
  decrypt: vi.fn(() => 'decrypted-password'),
  stat: vi.fn(() => ({ isFile: () => true, size: 100 })),
  read: vi.fn(() => Buffer.from('private-key')),
}));
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => mocks.encryptionAvailable,
    decryptString: mocks.decrypt,
  },
}));
vi.mock('../../src/main/desktop-prefs', () => ({
  readDesktopPrefsFile: () => mocks.prefs,
  writeDesktopPrefsFile: vi.fn(),
}));
vi.mock('node:fs', () => ({ statSync: mocks.stat, readFileSync: mocks.read }));

import { savedSshConnectConfig } from '../../src/main/ssh-configs';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.encryptionAvailable = true;
  mocks.prefs.sshConnections = [{
    id: 'server', name: 'Server', host: 'server.local', port: 2222, username: 'user',
    authType: 'password', encryptedPassword: Buffer.from('encrypted').toString('base64'),
  }];
});

it('resolves saved host and encrypted password without exposing them in tool arguments', () => {
  expect(savedSshConnectConfig('server')).toEqual({
    host: 'server.local', port: 2222, username: 'user', password: 'decrypted-password', readyTimeout: 18_000,
  });
  expect(mocks.decrypt).toHaveBeenCalledWith(Buffer.from('encrypted'));
});

it('requires a real saved id', () => {
  expect(() => savedSshConnectConfig('missing')).toThrow('不存在');
  expect(() => savedSshConnectConfig('../server')).toThrow('id');
});

it('fails explicitly if secure storage is unavailable or the password is missing', () => {
  mocks.encryptionAvailable = false;
  expect(() => savedSshConnectConfig('server')).toThrow('安全存储不可用');
  mocks.encryptionAvailable = true;
  delete mocks.prefs.sshConnections[0].encryptedPassword;
  expect(() => savedSshConnectConfig('server')).toThrow('密码');
});

it('loads a saved private key with the existing file size guard', () => {
  Object.assign(mocks.prefs.sshConnections[0], { authType: 'privateKey', privateKeyPath: 'key.pem' });
  const resolved = savedSshConnectConfig('server');
  expect(resolved.privateKey).toEqual(Buffer.from('private-key'));
  expect(resolved.password).toBeUndefined();
  mocks.stat.mockReturnValueOnce({ isFile: () => true, size: 1024 * 1024 + 1 });
  expect(() => savedSshConnectConfig('server')).toThrow('1 MB');
});

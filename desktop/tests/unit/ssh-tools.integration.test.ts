import { generateKeyPairSync } from 'node:crypto';
import { once } from 'node:events';
import { Server, utils } from 'ssh2';
import { afterEach, expect, it, vi } from 'vitest';

const config = vi.hoisted(() => ({ port: 0 }));
vi.mock('../../src/main/ssh-configs', () => ({
  listSshConnections: () => [{ id: 'local', name: 'Local test server', host: '127.0.0.1' }],
  savedSshConnectConfig: () => ({
    host: '127.0.0.1', port: config.port, username: 'test', password: 'test-only',
  }),
}));

import { SshTools } from '../../src/main/ssh-tools';

const tools = new SshTools();
let server: Server | undefined;
const serverErrors: Error[] = [];
afterEach(async () => {
  tools.dispose();
  if (server) {
    const closed = once(server, 'close');
    server.close();
    await closed;
    server = undefined;
  }
  expect(serverErrors).toEqual([]);
  serverErrors.length = 0;
});

it('executes commands and round-trips UTF-8 files over a real local SSH/SFTP connection', async () => {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const files = new Map<string, Buffer>();
  server = new Server({ hostKeys: [privateKey] }, (connection) => {
    connection.on('error', (error: Error) => { serverErrors.push(error); });
    connection.on('authentication', (ctx) => {
      if (ctx.method === 'password' && ctx.username === 'test' && ctx.password === 'test-only') ctx.accept();
      else ctx.reject();
    });
    connection.on('ready', () => {
      connection.on('session', (accept) => {
        const session = accept();
        session.on('exec', (acceptExec, _reject, info) => {
          const stream = acceptExec();
          stream.write(`received: ${info.command}\n`);
          stream.stderr.write('test stderr\n');
          stream.exit(3);
          stream.end();
        });
        session.on('sftp', (acceptSftp) => {
          const channel = acceptSftp();
          channel.on('OPEN', (id, path, flags) => {
            if (flags & utils.sftp.OPEN_MODE.CREAT) files.set(path, Buffer.alloc(0));
            if (!files.has(path)) { channel.status(id, utils.sftp.STATUS_CODE.NO_SUCH_FILE); return; }
            channel.handle(id, Buffer.from(path));
          });
          channel.on('FSTAT', (id, handle) => {
            channel.attrs(id, {
              mode: 0o100644, uid: 0, gid: 0, size: files.get(handle.toString())?.length ?? 0,
              atime: 0, mtime: 0,
            });
          });
          channel.on('WRITE', (id, handle, offset, data) => {
            const path = handle.toString();
            const previous = files.get(path) ?? Buffer.alloc(0);
            const next = Buffer.alloc(Math.max(previous.length, offset + data.length));
            previous.copy(next);
            data.copy(next, offset);
            files.set(path, next);
            channel.status(id, utils.sftp.STATUS_CODE.OK);
          });
          channel.on('READ', (id, handle, offset, length) => {
            const data = files.get(handle.toString()) ?? Buffer.alloc(0);
            if (offset >= data.length) channel.status(id, utils.sftp.STATUS_CODE.EOF);
            else channel.data(id, data.subarray(offset, offset + length));
          });
          channel.on('CLOSE', (id) => channel.status(id, utils.sftp.STATUS_CODE.OK));
        });
      });
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (typeof address === 'string' || !address) throw new Error('Missing local SSH server address');
  config.port = address.port;
  const rpc = (method: string, params: Record<string, unknown> = {}) =>
    tools.handleRpc({ method, params, runtime_key: 'crew_test' });
  expect(await rpc('ssh_list')).toEqual([{ id: 'local', name: 'Local test server' }]);
  const profileId = await rpc('ssh_connent', { id: 'local' });
  expect(typeof profileId).toBe('string');
  expect(await rpc('ssh_exec', { profileId, command: 'test command' })).toEqual({
    exitCode: 3, stdout: 'received: test command\n', stderr: 'test stderr\n',
  });
  const path = "/tmp/a file ' ;.txt";
  const content = 'SSH UTF-8: 你好\n';
  expect(await rpc('ssh_write_file', { profileId, path, content })).toEqual({ ok: true });
  expect(await rpc('ssh_read_file', { profileId, path })).toEqual({ content });
  expect(await rpc('ssh_write_file', { profileId, path, content: '' })).toEqual({ ok: true });
  expect(await rpc('ssh_read_file', { profileId, path })).toEqual({ content: '' });
  await expect(rpc('ssh_read_file', { profileId, path: '/missing' })).rejects.toThrow();
}, 15_000);

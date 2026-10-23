import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SshTools as SshToolsType } from '../../src/main/ssh-tools';

const mocks = vi.hoisted(() => ({
  config: vi.fn(() => ({ host: 'server', username: 'user', password: 'secret' })),
  list: vi.fn(() => [{ id: 'server1', name: 'Server', host: 'private', password: 'secret' }]),
}));
vi.mock('../../src/main/ssh-configs', () => ({
  savedSshConnectConfig: mocks.config,
  listSshConnections: mocks.list,
}));

class FakeClient extends EventEmitter {
  static instances: FakeClient[] = [];
  stream = Object.assign(new PassThrough(), { stderr: new PassThrough() });
  fileStream = new PassThrough();
  sftpChannel = Object.assign(new EventEmitter(), {
    createReadStream: vi.fn(() => this.fileStream),
    writeFile: vi.fn((_path: string, _content: string, _options: unknown, done: (error?: Error) => void) => done()),
    end: vi.fn(),
  });
  destroy = vi.fn(() => { this.emit('close'); });
  connect = vi.fn(() => { queueMicrotask(() => this.emit('ready')); });
  exec = vi.fn((_command: string, done: (error: Error | undefined, stream: typeof this.stream) => void) => {
    done(undefined, this.stream);
  });
  sftp = vi.fn((done: (error: Error | undefined, channel: typeof this.sftpChannel) => void) => {
    done(undefined, this.sftpChannel);
  });
  constructor() {
    super();
    FakeClient.instances.push(this);
  }
}
vi.doMock('ssh2', () => ({ Client: FakeClient }));

const { SshTools } = await import('../../src/main/ssh-tools');

describe('SSH model tools', () => {
  let tools: SshToolsType;
  const rpc = (method: string, params: Record<string, unknown> = {}, runtimeKey = 'crew_account') =>
    tools.handleRpc({ method, params, runtime_key: runtimeKey });
  const connect = async (): Promise<string> => {
    const result = await rpc('ssh_connent', { id: 'server1' });
    expect(typeof result).toBe('string');
    return String(result);
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    FakeClient.instances = [];
    tools = new SshTools();
  });
  afterEach(() => { tools.dispose(); vi.useRealTimers(); });

  it('lists only id and name, never connection details', async () => {
    expect(await rpc('ssh_list')).toEqual([{ id: 'server1', name: 'Server' }]);
  });

  it('connects from the saved configuration and expires exactly after ten idle minutes', async () => {
    const profileId = await connect();
    const client = FakeClient.instances[0];
    expect(mocks.config).toHaveBeenCalledWith('server1');
    expect(client.connect).toHaveBeenCalledWith(mocks.config());
    await vi.advanceTimersByTimeAsync(599_999);
    expect(client.destroy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(client.destroy).toHaveBeenCalledTimes(1);
    await expect(rpc('ssh_exec', { profileId, command: 'pwd' })).rejects.toThrow('expired');
    expect(await connect()).not.toBe(profileId);
  });

  it('returns nonzero exit codes and UTF-8 stdout/stderr and resets the idle timer', async () => {
    const profileId = await connect();
    await vi.advanceTimersByTimeAsync(599_000);
    const operation = rpc('ssh_exec', { profileId, command: 'false' });
    const client = FakeClient.instances[0];
    const utf8 = Buffer.from('你好');
    client.stream.emit('data', utf8.subarray(0, 2));
    client.stream.emit('data', utf8.subarray(2));
    client.stream.stderr.emit('data', Buffer.from('failed'));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(client.destroy).not.toHaveBeenCalled();
    client.stream.emit('close', 7);
    expect(await operation).toEqual({ exitCode: 7, stdout: '你好', stderr: 'failed' });
    await vi.advanceTimersByTimeAsync(599_999);
    expect(client.destroy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(client.destroy).toHaveBeenCalledTimes(1);
  });

  it('rejects unknown and cross-account handles', async () => {
    const profileId = await connect();
    await expect(rpc('ssh_read_file', { profileId: 'missing', path: '/a' })).rejects.toThrow('expired');
    await expect(rpc('ssh_read_file', { profileId, path: '/a' }, 'crew_other')).rejects.toThrow('expired');
    expect(FakeClient.instances[0].sftp).not.toHaveBeenCalled();
  });

  it('reads and writes text over SFTP, including empty content and shell metacharacters in paths', async () => {
    const profileId = await connect();
    const path = "/tmp/a' ; echo no";
    const reading = rpc('ssh_read_file', { profileId, path });
    const client = FakeClient.instances[0];
    client.fileStream.end(Buffer.from('hello\n'));
    expect(await reading).toEqual({ content: 'hello\n' });
    expect(await rpc('ssh_write_file', { profileId, path, content: '' })).toEqual({ ok: true });
    expect(client.sftpChannel.writeFile).toHaveBeenCalledWith(
      path, '', { encoding: 'utf8' }, expect.any(Function),
    );
    expect(client.exec).not.toHaveBeenCalled();
  });

  it('closes timed-out operations and does not silently reconnect', async () => {
    const profileId = await connect();
    const operation = rpc('ssh_exec', { profileId, command: 'sleep 90' });
    const assertion = expect(operation).rejects.toThrow('remote outcome unknown');
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;
    expect(FakeClient.instances[0].destroy).toHaveBeenCalledTimes(1);
    await expect(rpc('ssh_exec', { profileId, command: 'pwd' })).rejects.toThrow('expired');
  });

  it('fails explicitly on command, SFTP and missing exit status errors', async () => {
    const profileId = await connect();
    const client = FakeClient.instances[0];
    const execution = rpc('ssh_exec', { profileId, command: 'pwd' });
    client.stream.emit('close', null, 'TERM');
    await expect(execution).rejects.toThrow('exit code');
    const reading = rpc('ssh_read_file', { profileId, path: '/missing' });
    client.fileStream.emit('error', new Error('Permission denied'));
    await expect(reading).rejects.toThrow('Permission denied');
    client.exec.mockImplementationOnce(() => { throw new Error('exec failed'); });
    await expect(rpc('ssh_exec', { profileId, command: 'pwd' })).rejects.toThrow('exec failed');
  });

  it('rejects oversized output and files rather than returning partial success', async () => {
    const profileId = await connect();
    const client = FakeClient.instances[0];
    const execution = rpc('ssh_exec', { profileId, command: 'cat large' });
    client.stream.emit('data', Buffer.alloc(1024 * 1024 + 1));
    await expect(execution).rejects.toThrow('exceeds');
    const reading = rpc('ssh_read_file', { profileId, path: '/large' });
    client.fileStream.emit('data', Buffer.alloc(1024 * 1024 + 1));
    await expect(reading).rejects.toThrow('exceeds');
    await expect(rpc('ssh_write_file', {
      profileId, path: '/large', content: 'a'.repeat(1024 * 1024 + 1),
    })).rejects.toThrow('exceeds');
  });

  it('accepts exactly 1 MiB of command output and file data', async () => {
    const profileId = await connect();
    const client = FakeClient.instances[0];
    const data = Buffer.alloc(1024 * 1024, 'a');
    const execution = rpc('ssh_exec', { profileId, command: 'cat boundary' });
    client.stream.emit('data', data);
    client.stream.emit('close', 0);
    expect(await execution).toEqual({ exitCode: 0, stdout: data.toString(), stderr: '' });
    const reading = rpc('ssh_read_file', { profileId, path: '/boundary' });
    client.fileStream.end(data);
    expect(await reading).toEqual({ content: data.toString() });
    expect(await rpc('ssh_write_file', {
      profileId, path: '/boundary', content: data.toString(),
    })).toEqual({ ok: true });
  });

  it('rejects in-flight work immediately on disconnect and marks mutations uncertain', async () => {
    const profileId = await connect();
    const operation = rpc('ssh_exec', { profileId, command: 'touch /a' });
    FakeClient.instances[0].emit('close');
    await expect(operation).rejects.toMatchObject({ uncertain: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('disposes live and connecting clients, invalidates handles and clears timers', async () => {
    const profileId = await connect();
    tools.dispose();
    expect(vi.getTimerCount()).toBe(0);
    await expect(rpc('ssh_read_file', { profileId, path: '/a' })).rejects.toThrow('expired');
    const pending = rpc('ssh_connent', { id: 'server1' });
    tools.dispose();
    await expect(pending).rejects.toThrow('closed');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('propagates authentication failures and connection timeouts without leaking sessions', async () => {
    const failed = rpc('ssh_connent', { id: 'server1' });
    FakeClient.instances[0].emit('error', new Error('Authentication failed'));
    await expect(failed).rejects.toThrow('Authentication failed');
    expect(vi.getTimerCount()).toBe(0);
    const pending = rpc('ssh_connent', { id: 'server1' });
    FakeClient.instances[1].removeAllListeners('ready');
    const assertion = expect(pending).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(20_000);
    await assertion;
    expect(FakeClient.instances[1].destroy).toHaveBeenCalledTimes(1);
  });
});

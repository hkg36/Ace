import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { Client } from 'ssh2';
import { listSshConnections, savedSshConnectConfig } from './ssh-configs';

const IDLE_TIMEOUT_MS = 10 * 60_000;
const OPERATION_TIMEOUT_MS = 60_000;
const MAX_BYTES = 1024 * 1024;

export class SshToolError extends Error {
  constructor(message: string, readonly uncertain: boolean) {
    super(message);
    this.name = 'SshToolError';
  }
}

interface SshSession {
  client: Client;
  runtimeKey: string;
  active: number;
  error?: Error;
  idleTimer?: ReturnType<typeof setTimeout>;
}

function text(params: Record<string, unknown>, key: string, allowEmpty = false): string {
  const value = params[key];
  if (typeof value !== 'string' || (!allowEmpty && (!value.trim() || value.includes('\0')))) {
    throw new Error(`Invalid SSH parameter: ${key}`);
  }
  return value;
}

export class SshTools {
  private readonly sessions = new Map<string, SshSession>();

  dispose(): void {
    for (const id of this.sessions.keys()) this.close(id);
  }

  private close(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    clearTimeout(session.idleTimer);
    session.client.destroy();
  }

  private armIdle(id: string, session: SshSession): void {
    clearTimeout(session.idleTimer);
    if (session.active || this.sessions.get(id) !== session) return;
    session.idleTimer = setTimeout(() => this.close(id), IDLE_TIMEOUT_MS);
    session.idleTimer.unref();
  }

  async handleRpc(request: Record<string, unknown>): Promise<unknown> {
    const runtimeKey = text(request, 'runtime_key');
    const raw = request.params;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('Invalid SSH parameters');
    }
    const params = raw as Record<string, unknown>;
    switch (request.method) {
      case 'ssh_list':
        return listSshConnections().map(({ id, name }) => ({ id, name }));
      case 'ssh_connent':
        return this.connect(runtimeKey, text(params, 'id'));
      case 'ssh_exec':
      case 'ssh_read_file':
      case 'ssh_write_file':
        return this.operate(runtimeKey, request.method, params);
      default:
        throw new Error('Unknown SSH method');
    }
  }

  private async connect(runtimeKey: string, id: string): Promise<string> {
    const config = savedSshConnectConfig(id);
    const profileId = randomUUID();
    const client = new Client();
    const session: SshSession = { client, runtimeKey, active: 0 };
    this.sessions.set(profileId, session);
    client.on('error', (error: Error) => {
      session.error = error;
      this.close(profileId);
    });
    client.once('close', () => this.close(profileId));
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => finish(new Error('SSH connection timed out')), 20_000);
        const onReady = (): void => finish();
        const onError = (error: Error): void => finish(error);
        const onClose = (): void => finish(session.error ?? new Error('SSH connection closed before authentication'));
        const finish = (error?: Error): void => {
          clearTimeout(timeout);
          client.off('ready', onReady);
          client.off('error', onError);
          client.off('close', onClose);
          if (error) reject(error);
          else resolve();
        };
        client.once('ready', onReady);
        client.once('error', onError);
        client.once('close', onClose);
        try {
          client.connect(config);
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      });
      if (this.sessions.get(profileId) !== session) throw new Error('SSH connection closed');
      this.armIdle(profileId, session);
      return profileId;
    } catch (error) {
      this.close(profileId);
      throw error;
    }
  }

  private async operate(
    runtimeKey: string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const id = text(params, 'profileId');
    const session = this.sessions.get(id);
    if (!session || session.runtimeKey !== runtimeKey) {
      throw new Error('SSH handle invalid or expired; call ssh_connent again');
    }
    const commandOrPath = text(params, method === 'ssh_exec' ? 'command' : 'path');
    const content = method === 'ssh_write_file' ? text(params, 'content', true) : '';
    if (Buffer.byteLength(content) > MAX_BYTES) throw new Error('SSH file exceeds 1 MiB');
    session.active += 1;
    clearTimeout(session.idleTimer);
    let cleanup: (() => void) | undefined;
    try {
      return await new Promise<unknown>((resolve, reject) => {
        const closed = (): void => reject(new SshToolError(
          'SSH connection closed; operation may be incomplete. Reconnect before further operations.',
          method !== 'ssh_read_file',
        ));
        session.client.once('close', closed);
        const timeout = setTimeout(() => {
          reject(new SshToolError(
            'SSH operation timed out; connection closed, remote outcome unknown',
            method !== 'ssh_read_file',
          ));
          this.close(id);
        }, OPERATION_TIMEOUT_MS);
        cleanup = () => {
          clearTimeout(timeout);
          session.client.off('close', closed);
        };
        const operation = method === 'ssh_exec'
          ? this.exec(session.client, commandOrPath)
          : this.file(session.client, commandOrPath, method === 'ssh_write_file' ? content : undefined);
        void operation.then(resolve, reject);
      });
    } finally {
      cleanup?.();
      session.active -= 1;
      this.armIdle(id, session);
    }
  }

  private exec(client: Client, command: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      client.exec(command, (error, stream) => {
        if (error) { reject(error); return; }
        const stdout = new StringDecoder('utf8');
        const stderr = new StringDecoder('utf8');
        let out = '';
        let err = '';
        let size = 0;
        const append = (chunk: Buffer, isError: boolean): void => {
          size += chunk.length;
          if (size > MAX_BYTES) {
            reject(new SshToolError('SSH command output exceeds 1 MiB; remote outcome unknown', true));
            stream.destroy();
            return;
          }
          if (isError) err += stderr.write(chunk);
          else out += stdout.write(chunk);
        };
        stream.on('data', (chunk: Buffer) => append(chunk, false));
        stream.stderr.on('data', (chunk: Buffer) => append(chunk, true));
        const streamError = (error: Error): void => reject(new SshToolError(error.message, true));
        stream.on('error', streamError);
        stream.stderr.on('error', streamError);
        stream.on('close', (code: number | null, signal?: string) => {
          if (!Number.isInteger(code)) {
            reject(new SshToolError(
              `SSH command ended without an exit code${signal ? ` (${signal})` : ''}`,
              true,
            ));
            return;
          }
          resolve({ exitCode: code, stdout: out + stdout.end(), stderr: err + stderr.end() });
        });
      });
    });
  }

  private file(client: Client, path: string, content?: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      client.sftp((error, sftp) => {
        if (error) { reject(error); return; }
        sftp.on('error', reject);
        if (content !== undefined) {
          sftp.writeFile(path, content, { encoding: 'utf8' }, (writeError) => {
            sftp.end();
            if (writeError) reject(new SshToolError(writeError.message, true));
            else resolve({ ok: true });
          });
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        const stream = sftp.createReadStream(path);
        stream.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BYTES) {
            reject(new Error('SSH file exceeds 1 MiB'));
            stream.destroy();
            sftp.end();
          } else chunks.push(chunk);
        });
        stream.on('error', (readError: Error) => { sftp.end(); reject(readError); });
        stream.on('end', () => {
          sftp.end();
          resolve({ content: Buffer.concat(chunks).toString('utf8') });
        });
      });
    });
  }
}

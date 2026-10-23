export type SshAuthType = 'password' | 'privateKey';

export interface SshConnectionInput {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authType: SshAuthType;
  password?: string;
  privateKeyPath?: string;
}

export interface SshConnectionSummary {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authType: SshAuthType;
  privateKeyPath?: string;
  hasPassword: boolean;
}

export interface SshConnectionTestResult {
  ok: boolean;
  error?: string;
}

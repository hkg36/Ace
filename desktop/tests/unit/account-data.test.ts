import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { removeAccountDataDirectory } from '../../src/main/account-data';

const temporaryRoots: string[] = [];

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'account-data-'));
  temporaryRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('removeAccountDataDirectory', () => {
  it('removes only the matching hashed account directory', async () => {
    const home = temporaryRoot();
    const accountId = 'tenant:user-1';
    const segment = `acct_${createHash('sha256').update(accountId, 'utf8').digest('hex').slice(0, 16)}`;
    const accountDirectory = path.join(home, 'accounts', segment);
    const otherDirectory = path.join(home, 'accounts', 'acct_other');
    fs.mkdirSync(accountDirectory, { recursive: true });
    fs.mkdirSync(otherDirectory, { recursive: true });
    fs.writeFileSync(path.join(accountDirectory, 'memory.txt'), 'private account data');
    fs.writeFileSync(path.join(otherDirectory, 'memory.txt'), 'keep');

    await removeAccountDataDirectory(accountId, home);

    expect(fs.existsSync(accountDirectory)).toBe(false);
    expect(fs.readFileSync(path.join(otherDirectory, 'memory.txt'), 'utf8')).toBe('keep');
  });

  it('rejects identities that resemble filesystem paths', async () => {
    await expect(removeAccountDataDirectory('tenant:../someone', temporaryRoot()))
      .rejects.toThrow('无效的账号身份');
  });

  it('supports CREW_HOME pointing directly at the matching owner folder', async () => {
    const accountId = 'tenant:user-1';
    const segment = `acct_${createHash('sha256').update(accountId, 'utf8').digest('hex').slice(0, 16)}`;
    const ownerHome = path.join(temporaryRoot(), 'accounts', segment);
    fs.mkdirSync(ownerHome, { recursive: true });
    fs.writeFileSync(path.join(ownerHome, 'memory.txt'), 'private account data');

    await removeAccountDataDirectory(accountId, ownerHome);

    expect(fs.existsSync(ownerHome)).toBe(false);
  });
});

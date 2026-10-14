import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export async function removeAccountDataDirectory(accountId: string, crewHome: string): Promise<void> {
  if (!accountId || /[\/\\\0]/.test(accountId) || accountId.startsWith('~')) {
    throw new Error('无效的账号身份，已取消删除。');
  }
  const digest = createHash('sha256').update(accountId, 'utf8').digest('hex').slice(0, 16);
  const segment = `acct_${digest}`;
  const configuredHome = path.resolve(crewHome);
  const configuredHomeIsOwner = path.basename(path.dirname(configuredHome)) === 'accounts'
    && path.basename(configuredHome) === segment;
  const ownerHome = configuredHomeIsOwner
    ? configuredHome
    : path.join(configuredHome, 'accounts', segment);
  const accountsDirectory = path.dirname(ownerHome);
  if (!fs.existsSync(ownerHome)) return;

  const rootPath = configuredHomeIsOwner ? path.dirname(accountsDirectory) : configuredHome;
  const rootRealPath = fs.realpathSync(rootPath);
  const accountsStats = fs.lstatSync(accountsDirectory);
  if (accountsStats.isSymbolicLink() || !accountsStats.isDirectory()) {
    throw new Error('账号数据目录位置不安全，已取消删除。');
  }
  const accountsRealPath = fs.realpathSync(accountsDirectory);
  const relativeAccountsPath = path.relative(rootRealPath, accountsRealPath);
  if (
    relativeAccountsPath === ''
    || relativeAccountsPath.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativeAccountsPath)
  ) {
    throw new Error('账号数据目录超出 Crew 主目录，已取消删除。');
  }

  const ownerStats = fs.lstatSync(ownerHome);
  if (ownerStats.isSymbolicLink() || !ownerStats.isDirectory()) {
    throw new Error('账号记录不是普通目录，已取消删除。');
  }
  const ownerRealPath = fs.realpathSync(ownerHome);
  if (path.dirname(ownerRealPath) !== accountsRealPath || path.basename(ownerRealPath) !== segment) {
    throw new Error('账号数据目录校验失败，已取消删除。');
  }
  await fs.promises.rm(ownerRealPath, { recursive: true, force: false });
}

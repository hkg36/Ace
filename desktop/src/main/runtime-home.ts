import { createHash } from 'node:crypto';
import path from 'node:path';

export const DEFAULT_WORKSPACE_DIRNAME = 'default_workspace';

export function runtimeHomeSegment(owner: string): string {
  if (owner === 'local') return DEFAULT_WORKSPACE_DIRNAME;
  const digest = createHash('sha256').update(owner, 'utf8').digest('hex').slice(0, 16);
  return `acct_${digest}`;
}

export function runtimeHomePath(crewHome: string, segment: string): string {
  return segment === DEFAULT_WORKSPACE_DIRNAME
    ? path.resolve(crewHome, segment)
    : path.resolve(crewHome, 'accounts', segment);
}

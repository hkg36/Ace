import { createHash } from 'node:crypto';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runtimeHomePath, runtimeHomeSegment } from '../../src/main/runtime-home';

describe('runtime home paths', () => {
  it('uses default_workspace only for the local identity', () => {
    const home = path.resolve('crew-home');
    expect(runtimeHomeSegment('local')).toBe('default_workspace');
    expect(runtimeHomePath(home, runtimeHomeSegment('local')))
      .toBe(path.join(home, 'default_workspace'));
    for (const owner of ['dev:dev', 'provider:user']) {
      const segment = `acct_${createHash('sha256').update(owner).digest('hex').slice(0, 16)}`;
      expect(runtimeHomeSegment(owner)).toBe(segment);
      expect(runtimeHomePath(home, segment)).toBe(path.join(home, 'accounts', segment));
    }
  });
});

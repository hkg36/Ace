import { describe, expect, it } from 'vitest';

import {
  managedGatewayModeEnv,
  resolveGatewayCrewHome,
  resolveGatewayIdentityMode,
  shouldProbeExternalGateway,
} from '../../src/main/gateway-launch-mode';

describe('resolveGatewayIdentityMode', () => {
  it('uses local mode for normal launches', () => {
    expect(resolveGatewayIdentityMode(false)).toBe('local');
  });

  it('uses isolated dev mode for development launches', () => {
    expect(resolveGatewayIdentityMode(true)).toBe('dev');
  });
});

describe('Gateway launch policy', () => {
  it('runs a private local-auth Gateway for normal desktop launches', () => {
    expect(resolveGatewayCrewHome('local', 'C:/local-home', 'C:/dev-home'))
      .toBe('C:/local-home');
    expect(managedGatewayModeEnv('local', 'C:/dev-home')).toEqual({
      CREW_AUTH_MODE: 'local',
    });
    expect(shouldProbeExternalGateway('local')).toBe(false);
  });

  it('isolates dev fallback and requires its managed Gateway', () => {
    expect(resolveGatewayCrewHome('dev', 'C:/account-home', 'C:/dev-home'))
      .toBe('C:/dev-home');
    expect(managedGatewayModeEnv('dev', 'C:/dev-home')).toEqual({
      CREW_GATEWAY_DEV: '1',
      CREW_HOME: 'C:/dev-home',
      CREW_AUTH_MODE: 'local',
    });
    expect(shouldProbeExternalGateway('dev')).toBe(false);
  });
});

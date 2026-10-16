import type { AuthUserSnapshot } from '../shared/types';

export type GatewayIdentityMode = 'local' | 'dev';

/** Resolve the Gateway identity used for this Desktop process lifetime. */
export function resolveGatewayIdentityMode(
  isDevLaunch: boolean,
  _jwt?: string | null,
  _userInfo?: AuthUserSnapshot | null,
): GatewayIdentityMode {
  return isDevLaunch ? 'dev' : 'local';
}

/** Return the child-process overrides required by the selected identity mode. */
export function managedGatewayModeEnv(
  mode: GatewayIdentityMode,
  devHome: string,
): Record<string, string> {
  return mode === 'dev'
    ? { CREW_GATEWAY_DEV: '1', CREW_HOME: devHome, CREW_AUTH_MODE: 'local' }
    : { CREW_AUTH_MODE: 'local' };
}

/**
 * Resolve the CREW_HOME shared by the Desktop verifier and its Gateway.
 * 统一指向真实 crew home（config 的 ~/.Crew），避免 dev 模式把数据隔离到空目录。
 */
export function resolveGatewayCrewHome(
  mode: GatewayIdentityMode,
  accountHome: string,
  devHome: string,
): string {
  return mode === 'dev' ? devHome : accountHome;
}

/** The Desktop owns a local Gateway so stale auth modes cannot block local requests. */
export function shouldProbeExternalGateway(_mode: GatewayIdentityMode): boolean {
  return false;
}

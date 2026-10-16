// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const showConfirmDialogMock = vi.hoisted(() => vi.fn(async () => true));

vi.mock('../../src/ui/state', () => ({
  notify: vi.fn(),
  state: { activeSessionId: null, sessions: [] },
}));
vi.mock('../../src/ui/ui-feedback', () => ({
  showConfirmDialog: showConfirmDialogMock,
}));

import {
  deriveState,
  refreshSecurityBanner,
  renderSecurityBanner,
  stopSecurityBannerRefresh,
} from '../../src/ui/features/security-banner';

beforeEach(() => {
  showConfirmDialogMock.mockClear();
  showConfirmDialogMock.mockResolvedValue(true);
  document.body.innerHTML = '<div class="chat-composer"><div class="composer-edit-banner"></div></div>';
  Object.assign(window, {
    Crew: {
      runtimePlatform: 'darwin',
      securityCapabilities: vi.fn(async () => ({
        ok: true,
        body: {
          platform: 'windows',
          helper_present: true,
          runtime_stale: true,
          filesystem_sandbox: false,
          managed_network: false,
        },
      })),
    },
  });
});

afterEach(() => {
  stopSecurityBannerRefresh();
  document.body.replaceChildren();
});

describe('security banner deriveState', () => {
  it('reports on when macOS Seatbelt and managed networking are active', () => {
    expect(deriveState({ platform: 'darwin', helper_present: true, filesystem_sandbox: true, managed_network: true })).toBe('on');
  });

  it('reports incomplete instead of offering Windows setup on macOS', () => {
    expect(deriveState({ platform: 'darwin', helper_present: true, filesystem_sandbox: false, managed_network: false })).toBe('mac-incomplete');
  });

  it('does not show a platform-specific setup prompt before detection completes', () => {
    expect(deriveState({ helper_present: false })).toBe('hidden');
  });

  it.each(['windows', 'win32'])('hides all sandbox states on %s', (platform) => {
    expect(deriveState({ platform, helper_present: false })).toBe('hidden');
    expect(deriveState({
      platform,
      helper_present: true,
      runtime_stale: true,
      filesystem_sandbox: false,
      managed_network: false,
    })).toBe('hidden');
    expect(deriveState({
      platform,
      helper_present: true,
      filesystem_sandbox: true,
      managed_network: true,
    })).toBe('hidden');
  });

  it('does not show a Windows setup prompt returned by the gateway', async () => {
    await refreshSecurityBanner();

    const banner = document.getElementById('security-sandbox-banner');
    expect(banner?.classList.contains('show')).toBe(false);
    expect(banner?.querySelector('[data-action="enable"]')).toBeNull();
  });

  it('removes an existing banner and stops polling on Windows', async () => {
    vi.useFakeTimers();
    renderSecurityBanner();
    expect(document.getElementById('security-sandbox-banner')).not.toBeNull();
    const securitySetup = vi.fn(async () => ({ ok: true, exitCode: 0 }));
    const securityCapabilities = vi.fn();
    Object.assign(window.Crew, { runtimePlatform: 'win32', securitySetup, securityCapabilities });
    try {
      await refreshSecurityBanner();
      await vi.advanceTimersByTimeAsync(60000);
      expect(document.getElementById('security-sandbox-banner')).toBeNull();
      expect(securityCapabilities).not.toHaveBeenCalled();
      expect(securitySetup).not.toHaveBeenCalled();
      expect(showConfirmDialogMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the macOS incomplete-protection banner', async () => {
    Object.assign(window.Crew, {
      securityCapabilities: vi.fn(async () => ({
        ok: true,
        body: { platform: 'darwin', helper_present: false },
      })),
    });
    await refreshSecurityBanner();
    const banner = document.getElementById('security-sandbox-banner');
    expect(banner?.classList.contains('show')).toBe(true);
    expect(banner?.querySelector('.security-banner__title')?.textContent).toBe('安全防护尚未就绪');
  });
});

import { describe, it, expect } from 'vitest';
import { HubConfig, HubConfigError } from '../../src/hub/hub-config.ts';

/**
 * Which hub (hub-plan "FluidCAD code"): `--hub`, then `FLUIDCAD_HUB_URL`,
 * then `https://hub.fluidcad.io`. A hub is an origin; trailing slashes are
 * trimmed and anything with a path is refused.
 */

describe('HubConfig.resolve', () => {
  it('takes --hub over FLUIDCAD_HUB_URL over the default', () => {
    const env = { FLUIDCAD_HUB_URL: 'http://localhost:8787' };

    const flag = HubConfig.resolve({ hub: 'https://hub-staging.fluidcad.io', env });
    expect(flag.origin).toBe('https://hub-staging.fluidcad.io');
    expect(flag.source).toBe('flag');

    const fromEnv = HubConfig.resolve({ env });
    expect(fromEnv.origin).toBe('http://localhost:8787');
    expect(fromEnv.source).toBe('env');

    const fallback = HubConfig.resolve({ env: {} });
    expect(fallback.origin).toBe('https://hub.fluidcad.io');
    expect(fallback.source).toBe('default');
  });

  it('treats a blank --hub or FLUIDCAD_HUB_URL as unset', () => {
    expect(HubConfig.resolve({ hub: '  ', env: { FLUIDCAD_HUB_URL: 'http://localhost:8787' } }).source).toBe('env');
    expect(HubConfig.resolve({ hub: null, env: { FLUIDCAD_HUB_URL: '' } }).origin).toBe(HubConfig.DEFAULT_URL);
  });

  it('trims trailing slashes and gives the API base', () => {
    const config = HubConfig.resolve({ hub: 'http://localhost:8787///', env: {} });
    expect(config.origin).toBe('http://localhost:8787');
    expect(config.apiBase).toBe('http://localhost:8787/api/v1');
    expect(config.api('')).toBe('http://localhost:8787/api/v1');
    expect(config.api('/me')).toBe('http://localhost:8787/api/v1/me');
    expect(config.api('cli/token')).toBe('http://localhost:8787/api/v1/cli/token');
    expect(config.url('/cli/authorize')).toBe('http://localhost:8787/cli/authorize');
  });

  it('lowercases the host and drops a default port, as an origin does', () => {
    expect(HubConfig.resolve({ hub: 'HTTPS://Hub.FluidCAD.io:443/', env: {} }).origin).toBe('https://hub.fluidcad.io');
  });

  it('refuses a URL with a path, a query, credentials or another scheme, naming where it came from', () => {
    expect(() => HubConfig.resolve({ hub: 'https://example.com/hub', env: {} })).toThrow(HubConfigError);
    expect(() => HubConfig.resolve({ hub: 'https://example.com/hub', env: {} })).toThrow(/--hub is the hub's address alone, like https:\/\/example\.com: drop "\/hub"/);
    expect(() => HubConfig.resolve({ env: { FLUIDCAD_HUB_URL: 'http://localhost:8787/?x=1' } })).toThrow(/FLUIDCAD_HUB_URL/);
    expect(() => HubConfig.resolve({ hub: 'https://me:pw@example.com', env: {} })).toThrow(/user name or password/);
    expect(() => HubConfig.resolve({ hub: 'ftp://example.com', env: {} })).toThrow(/http or https/);
    expect(() => HubConfig.resolve({ hub: 'hub.fluidcad.io', env: {} })).toThrow(/must be a URL like https:\/\/hub\.fluidcad\.io/);
  });
});

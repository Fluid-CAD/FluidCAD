import { describe, expect, it } from 'vitest';
import { LauncherAuth, hostnameOf, isLoopbackHost } from '../src/server/auth';

/** The Host names the start server answers to, as `--allowed-host` and a browser spell them. */
describe('hostnameOf', () => {
  it('drops the port and the case', () => {
    expect(hostnameOf('CAD-Server:3100')).toBe('cad-server');
    expect(hostnameOf('192.0.2.20:3100')).toBe('192.0.2.20');
    expect(hostnameOf(' cad-server ')).toBe('cad-server');
  });

  it('keeps an IPv6 address in brackets, written with or without them', () => {
    expect(hostnameOf('[fd00::1]:3100')).toBe('[fd00::1]');
    expect(hostnameOf('[fd00::1]')).toBe('[fd00::1]');
    expect(hostnameOf('fd00::1')).toBe('[fd00::1]');
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('[::1]:3100')).toBe(true);
  });
});

describe('allowed hosts', () => {
  it('matches a bare IPv6 allowed host against the bracketed Host a browser sends', () => {
    const auth = new LauncherAuth(3100, { exposed: true, allowedHosts: ['fd00::1', 'cad-server'] });
    expect(auth.hostAllowed('[fd00::1]:3100')).toBe(true);
    expect(auth.hostAllowed('cad-server:3100')).toBe(true);
    expect(auth.hostAllowed('[fd00::2]:3100')).toBe(false);
    expect(auth.hostAllowed('evil.example.com')).toBe(false);
    expect(auth.hostAllowed(undefined)).toBe(false);
  });

  it('answers every name when exposed without a list, and loopback only otherwise', () => {
    expect(new LauncherAuth(3100, { exposed: true }).hostAllowed('anything.example')).toBe(true);
    expect(new LauncherAuth(3100, { exposed: false }).hostAllowed('anything.example')).toBe(false);
    expect(new LauncherAuth(3100, { exposed: false }).hostAllowed('localhost:3100')).toBe(true);
  });
});

import { describe, it, expect } from 'vitest';
import { createHostGuard, createHostGuardVerifyClient, isLoopbackHostHeader } from '../src/host-guard.ts';

describe('host guard — the workspace server answers only to localhost', () => {
  it('accepts every loopback spelling, with or without a port', () => {
    for (const host of ['localhost', 'localhost:3100', 'LOCALHOST:3100', '127.0.0.1', '127.0.0.1:3457', '127.1.2.3', '[::1]', '[::1]:3100', 'app.localhost:3100']) {
      expect(isLoopbackHostHeader(host), host).toBe(true);
    }
  });

  it('rejects anything else, including a rebound hostname and a missing header', () => {
    for (const host of ['evil.example', 'evil.example:3100', '192.168.1.5:3100', '127.0.0.1.evil.example', 'localhost.evil.example', '10.0.0.1', undefined, '']) {
      expect(isLoopbackHostHeader(host), String(host)).toBe(false);
    }
  });

  it('answers 403 through express and refuses the WebSocket upgrade', () => {
    const guard = createHostGuard('127.0.0.1');
    const verify = createHostGuardVerifyClient('127.0.0.1');
    const respond = (host: string | undefined) => {
      let status = 200;
      let passed = false;
      const res = { status: (s: number) => { status = s; return res; }, json: () => res } as any;
      guard({ headers: { host } } as any, res, () => { passed = true; });
      return { status, passed };
    };
    expect(respond('localhost:3100')).toEqual({ status: 200, passed: true });
    expect(respond('evil.example')).toEqual({ status: 403, passed: false });
    expect(verify({ req: { headers: { host: '[::1]:3100' } } as any })).toBe(true);
    expect(verify({ req: { headers: { host: 'evil.example' } } as any })).toBe(false);
  });

  it('stands down when the server is deliberately bound beyond loopback', () => {
    const guard = createHostGuard('0.0.0.0');
    let passed = false;
    guard({ headers: { host: '192.168.1.5:3100' } } as any, {} as any, () => { passed = true; });
    expect(passed).toBe(true);
    expect(createHostGuardVerifyClient('0.0.0.0')({ req: { headers: { host: 'anything' } } } as any)).toBe(true);
  });
});

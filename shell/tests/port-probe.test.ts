import net from 'net';
import { afterEach, describe, expect, it } from 'vitest';
import { engineHost, findFreePort, isPortFree } from '../src/engine/process';

/**
 * The shell's port probe must agree with the engine's bind, not with a
 * looser one. On macOS a wildcard bind succeeds next to a loopback bind and
 * vice versa, so a probe on one address alone reports a port free that the
 * engine then fails to take (EADDRINUSE → "exited with code 1 before it was
 * ready"). Every holder below is released after each test.
 */
const holders: net.Server[] = [];

function hold(port: number, host?: string): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    holders.push(server);
    server.once('error', reject);
    if (host === undefined) {
      server.listen(port, () => resolve(server));
    } else {
      server.listen(port, host, () => resolve(server));
    }
  });
}

/** A port nothing holds right now, found by the probe under test itself. */
async function scratchPort(): Promise<number> {
  return findFreePort(3900, 100);
}

afterEach(async () => {
  await Promise.all(
    holders.splice(0).map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
});

describe('engineHost', () => {
  it('defaults to loopback, the address the engine binds', () => {
    expect(engineHost({})).toBe('127.0.0.1');
  });

  it('follows FLUIDCAD_SERVER_HOST when the engine is exposed deliberately', () => {
    expect(engineHost({ FLUIDCAD_SERVER_HOST: '0.0.0.0' })).toBe('0.0.0.0');
  });
});

describe('isPortFree', () => {
  it('reports an unheld port free', async () => {
    const port = await scratchPort();
    expect(await isPortFree(port)).toBe(true);
  });

  it('reports a port held on loopback busy (the fluidcad serve case)', async () => {
    const port = await scratchPort();
    await hold(port, '127.0.0.1');
    expect(await isPortFree(port)).toBe(false);
  });

  it('reports a port held on the wildcard busy (the second-engine case)', async () => {
    const port = await scratchPort();
    await hold(port);
    expect(await isPortFree(port)).toBe(false);
  });
});

describe('findFreePort', () => {
  it('skips a port another process holds on loopback', async () => {
    const start = await scratchPort();
    await hold(start, '127.0.0.1');
    expect(await findFreePort(start, 10)).toBe(start + 1);
  });

  it('skips a port another process holds on the wildcard', async () => {
    const start = await scratchPort();
    await hold(start);
    expect(await findFreePort(start, 10)).toBe(start + 1);
  });
});

import fs from 'fs';
import os from 'os';
import path from 'path';
import type { ChildProcess } from 'child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startEngine, stopEngine } from '../src/engine/process';
import type { ResolvedEngine } from '../src/engine/resolver';

/**
 * The startup handshake is the shell's business; the window's `onExit` is
 * for an engine that was running. Issue #66's screenshot shows what happens
 * otherwise: the engine reports a failed `init-complete`, `startEngine` reaps
 * it, and the reap itself surfaced as "The FluidCAD engine stopped (exit code
 * 0)" on top of the "could not be opened" page.
 */

/** Sends the handshake an engine sends, then idles like a listening server. */
const FAKE_ENGINE =
  "process.send({ type: 'ready', url: 'http://127.0.0.1:1' });\n" +
  "process.send({ type: 'init-complete', success: process.env.FAKE_ENGINE_SUCCESS === '1', error: 'Cannot find module fluidcad (fake)' });\n" +
  'setInterval(() => {}, 60_000);\n';

let dir: string;
let engine: ResolvedEngine;
let spawned: ChildProcess | null;

const exited = (child: ChildProcess) =>
  new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
    } else {
      child.once('exit', () => resolve());
    }
  });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-fake-engine-'));
  const serverEntry = path.join(dir, 'engine.cjs');
  fs.writeFileSync(serverEntry, FAKE_ENGINE);
  engine = { version: '0.0.0', packageRoot: dir, serverEntry, source: 'builtin', pin: null, unpinned: false };
  spawned = null;
});

afterEach(async () => {
  delete process.env.FAKE_ENGINE_SUCCESS;
  if (spawned) {
    stopEngine(spawned);
    await exited(spawned);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('startEngine', () => {
  it('reports a failed init through the rejection alone, not as an exit', async () => {
    process.env.FAKE_ENGINE_SUCCESS = '0';
    const onExit = vi.fn();
    await expect(
      startEngine(engine, dir, { onSpawn: (child) => (spawned = child), onExit }),
    ).rejects.toThrow('Cannot find module fluidcad (fake)');

    // The reap is the shell's own doing; the engine is gone…
    await exited(spawned!);
    // …and the window never heard of it as a crash.
    expect(onExit).not.toHaveBeenCalled();
  });

  it('hands the exit to the window once the engine was up', async () => {
    process.env.FAKE_ENGINE_SUCCESS = '1';
    const onExit = vi.fn();
    const started = await startEngine(engine, dir, { onSpawn: (child) => (spawned = child), onExit });
    expect(started.url).toBe('http://127.0.0.1:1');

    stopEngine(started.child);
    await exited(started.child);
    expect(onExit).toHaveBeenCalledTimes(1);
  });
});

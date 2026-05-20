import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  addInstance,
  removeInstance,
  readInstances,
  registryFilePath,
  isPidAlive,
  type RegistryEntry,
} from '../src/global-registry.ts';

// Re-route HOME to a tmp dir so tests don't touch the real ~/.fluidcad.
let fakeHome: string;
let homeSpy: ReturnType<typeof vi.spyOn>;

function entry(overrides: Partial<RegistryEntry> = {}): RegistryEntry {
  return {
    workspacePath: '/tmp/ws-a',
    port: 3847,
    pid: process.pid,
    version: '0.0.33',
    startedAt: '2026-05-20T12:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-registry-test-'));
  homeSpy = vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
});

afterEach(() => {
  homeSpy.mockRestore();
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

describe('addInstance', () => {
  it('creates the registry file with the first entry', () => {
    addInstance(entry({ workspacePath: '/tmp/ws-a' }));
    const raw = fs.readFileSync(registryFilePath(), 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.instances).toHaveLength(1);
    expect(parsed.instances[0].workspacePath).toBe('/tmp/ws-a');
  });

  it('appends a second workspace without dropping the first', () => {
    addInstance(entry({ workspacePath: '/tmp/ws-a' }));
    addInstance(entry({ workspacePath: '/tmp/ws-b', port: 3200 }));
    const all = readInstances();
    expect(all.map((e) => e.workspacePath).sort()).toEqual(['/tmp/ws-a', '/tmp/ws-b']);
  });

  it('replaces an entry for the same workspacePath (re-launch supersedes)', () => {
    addInstance(entry({ workspacePath: '/tmp/ws-a', port: 3000, pid: process.pid }));
    addInstance(entry({ workspacePath: '/tmp/ws-a', port: 4000, pid: process.pid }));
    const all = readInstances();
    expect(all).toHaveLength(1);
    expect(all[0].port).toBe(4000);
  });
});

describe('removeInstance', () => {
  it('removes an entry that matches workspacePath + pid', () => {
    addInstance(entry({ workspacePath: '/tmp/ws-a', pid: process.pid }));
    removeInstance('/tmp/ws-a', process.pid);
    expect(readInstances()).toHaveLength(0);
  });

  it('leaves the entry alone when pid does not match', () => {
    addInstance(entry({ workspacePath: '/tmp/ws-a', pid: process.pid }));
    removeInstance('/tmp/ws-a', 999999);
    expect(readInstances()).toHaveLength(1);
  });
});

describe('readInstances', () => {
  it('returns an empty array when the file does not exist', () => {
    expect(readInstances()).toEqual([]);
  });

  it('prunes entries with dead PIDs and persists the pruned set', () => {
    addInstance(entry({ workspacePath: '/tmp/ws-live', pid: process.pid }));
    // PID 1 is init on Linux — definitely alive but not us. Use a clearly
    // dead PID instead: pick one that has never existed in this session.
    addInstance(entry({ workspacePath: '/tmp/ws-dead', pid: 2 ** 22 - 1 }));

    const alive = readInstances();
    expect(alive.map((e) => e.workspacePath)).toEqual(['/tmp/ws-live']);

    // The prune was persisted, so a second read sees only the live entry too.
    const raw = JSON.parse(fs.readFileSync(registryFilePath(), 'utf8'));
    expect(raw.instances).toHaveLength(1);
    expect(raw.instances[0].workspacePath).toBe('/tmp/ws-live');
  });

  it('ignores malformed registry files', () => {
    fs.mkdirSync(path.dirname(registryFilePath()), { recursive: true });
    fs.writeFileSync(registryFilePath(), '{not json');
    expect(readInstances()).toEqual([]);
  });
});

describe('isPidAlive', () => {
  it('returns true for the current process', () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it('returns false for a clearly absent PID', () => {
    // 2^22-1 is an unlikely-to-be-real PID on default Linux configs.
    expect(isPidAlive(2 ** 22 - 1)).toBe(false);
  });
});

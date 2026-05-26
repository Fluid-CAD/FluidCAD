import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { listLiveInstances, findByWorkspace, registryFilePath } from '../src/discovery.ts';
import type { RegistryEntry } from '../src/types.ts';

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

function writeRegistry(entries: RegistryEntry[]): void {
  const dir = path.dirname(registryFilePath());
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(registryFilePath(), JSON.stringify({ schemaVersion: 1, instances: entries }));
}

beforeEach(() => {
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-mcp-discovery-test-'));
  homeSpy = vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
});

afterEach(() => {
  homeSpy.mockRestore();
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

describe('listLiveInstances', () => {
  it('returns an empty array when the registry is missing', () => {
    expect(listLiveInstances()).toEqual([]);
  });

  it('returns only entries whose PID is alive', () => {
    writeRegistry([
      entry({ workspacePath: '/tmp/ws-live', pid: process.pid }),
      entry({ workspacePath: '/tmp/ws-dead', pid: 2 ** 22 - 1 }),
    ]);
    const result = listLiveInstances();
    expect(result.map((e) => e.workspacePath)).toEqual(['/tmp/ws-live']);
  });

  it('does NOT write back the pruned list (MCP is read-only)', () => {
    writeRegistry([
      entry({ workspacePath: '/tmp/ws-dead', pid: 2 ** 22 - 1 }),
    ]);
    listLiveInstances();
    const raw = JSON.parse(fs.readFileSync(registryFilePath(), 'utf8'));
    expect(raw.instances).toHaveLength(1);
  });

  it('returns an empty array when the registry is malformed', () => {
    const dir = path.dirname(registryFilePath());
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(registryFilePath(), '{not json');
    expect(listLiveInstances()).toEqual([]);
  });
});

describe('findByWorkspace', () => {
  it('returns the entry that matches the workspace path', () => {
    writeRegistry([
      entry({ workspacePath: '/tmp/ws-a', pid: process.pid }),
      entry({ workspacePath: '/tmp/ws-b', port: 4000, pid: process.pid }),
    ]);
    const found = findByWorkspace('/tmp/ws-b');
    expect(found).not.toBeNull();
    expect(found!.port).toBe(4000);
  });

  it('returns null when no entry matches', () => {
    writeRegistry([entry({ workspacePath: '/tmp/ws-a', pid: process.pid })]);
    expect(findByWorkspace('/tmp/missing')).toBeNull();
  });

  it('skips dead entries even if path matches', () => {
    writeRegistry([entry({ workspacePath: '/tmp/ws-a', pid: 2 ** 22 - 1 })]);
    expect(findByWorkspace('/tmp/ws-a')).toBeNull();
  });
});

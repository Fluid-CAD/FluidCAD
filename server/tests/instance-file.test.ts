import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  writeInstanceFile,
  deleteInstanceFile,
  readInstanceFile,
  instanceFilePath,
  INSTANCE_DIR_NAME,
  INSTANCE_FILE_NAME,
  type InstanceFile,
} from '../src/instance-file.ts';

function makeEntry(workspacePath: string, overrides: Partial<InstanceFile> = {}): InstanceFile {
  return {
    schemaVersion: 1,
    port: 3847,
    pid: process.pid,
    workspacePath,
    version: '0.0.33',
    startedAt: '2026-05-20T12:00:00.000Z',
    ...overrides,
  };
}

let workspace: string;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-instance-test-'));
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('writeInstanceFile', () => {
  it('creates the .fluidcad directory and writes the file', () => {
    const entry = makeEntry(workspace);
    writeInstanceFile(entry);

    const dirPath = path.join(workspace, INSTANCE_DIR_NAME);
    expect(fs.existsSync(dirPath)).toBe(true);
    expect(fs.existsSync(path.join(dirPath, INSTANCE_FILE_NAME))).toBe(true);
  });

  it('round-trips the entry through readInstanceFile', () => {
    const entry = makeEntry(workspace, { port: 4000, pid: 99999 });
    writeInstanceFile(entry);
    const read = readInstanceFile(workspace);
    expect(read).toEqual(entry);
  });

  it('overwrites an existing file atomically', () => {
    writeInstanceFile(makeEntry(workspace, { port: 4000 }));
    writeInstanceFile(makeEntry(workspace, { port: 5000 }));
    expect(readInstanceFile(workspace)?.port).toBe(5000);

    // No tmp file should be left behind.
    const leftovers = fs
      .readdirSync(path.join(workspace, INSTANCE_DIR_NAME))
      .filter((name) => name.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });
});

describe('readInstanceFile', () => {
  it('returns null when the file is missing', () => {
    expect(readInstanceFile(workspace)).toBeNull();
  });

  it('returns null when the file is malformed', () => {
    const dir = path.join(workspace, INSTANCE_DIR_NAME);
    fs.mkdirSync(dir);
    fs.writeFileSync(instanceFilePath(workspace), '{not json');
    expect(readInstanceFile(workspace)).toBeNull();
  });

  it('returns null when the schema version is wrong', () => {
    const dir = path.join(workspace, INSTANCE_DIR_NAME);
    fs.mkdirSync(dir);
    fs.writeFileSync(
      instanceFilePath(workspace),
      JSON.stringify({ schemaVersion: 99, port: 1, pid: 1, workspacePath: '/', version: 'x', startedAt: 'x' }),
    );
    expect(readInstanceFile(workspace)).toBeNull();
  });
});

describe('deleteInstanceFile', () => {
  it('removes the file when pid matches', () => {
    const entry = makeEntry(workspace, { pid: 12345 });
    writeInstanceFile(entry);
    deleteInstanceFile(workspace, 12345);
    expect(readInstanceFile(workspace)).toBeNull();
  });

  it('leaves the file alone when pid does not match', () => {
    const entry = makeEntry(workspace, { pid: 12345 });
    writeInstanceFile(entry);
    deleteInstanceFile(workspace, 99999);
    expect(readInstanceFile(workspace)).toEqual(entry);
  });

  it('does not throw when the file is already gone', () => {
    expect(() => deleteInstanceFile(workspace, 1)).not.toThrow();
  });
});

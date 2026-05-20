import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { registryFilePath } from '../src/discovery.ts';
import {
  editRange,
  listFluidFiles,
  readFile,
  writeFile,
} from '../src/tools/source.ts';
import type { RegistryEntry } from '../src/types.ts';

let fakeHome: string;
let homeSpy: ReturnType<typeof vi.spyOn>;
let workspace: string;
let fakeServer: http.Server | null = null;
let fakePort = 0;
let dirtyFiles: { path: string; lastModifiedMs: number }[] = [];

function entry(overrides: Partial<RegistryEntry> = {}): RegistryEntry {
  return {
    workspacePath: workspace,
    port: fakePort,
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

function startFakeServer(): Promise<number> {
  return new Promise((resolve) => {
    fakeServer = http.createServer((req, res) => {
      const url = (req.url ?? '').split('?')[0];
      if (url === '/api/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, version: '0.0.33', workspacePath: workspace, startedAt: 'x', pid: process.pid }));
        return;
      }
      if (url === '/api/editor/dirty-files') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(dirtyFiles));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
    fakeServer.listen(0, '127.0.0.1', () => {
      const addr = fakeServer!.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve(port);
    });
  });
}

beforeEach(async () => {
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-mcp-source-test-'));
  homeSpy = vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-source-ws-'));
  workspace = fs.realpathSync(workspace);
  dirtyFiles = [];
  fakePort = await startFakeServer();
  writeRegistry([entry()]);
});

afterEach(async () => {
  homeSpy.mockRestore();
  fs.rmSync(fakeHome, { recursive: true, force: true });
  fs.rmSync(workspace, { recursive: true, force: true });
  if (fakeServer) {
    await new Promise<void>((resolve) => fakeServer!.close(() => resolve()));
    fakeServer = null;
  }
});

describe('read_file', () => {
  it('reads a workspace-relative path', async () => {
    fs.writeFileSync(path.join(workspace, 'part.fluid.js'), 'box(10, 10, 10);');
    const result = await readFile({ path: 'part.fluid.js' });
    expect(result.ok).toBe(true);
    if (!result.ok) { return; }
    expect(result.data.content).toBe('box(10, 10, 10);');
  });

  it('rejects paths that escape the workspace', async () => {
    const result = await readFile({ path: '../escape.txt' });
    expect(result.ok).toBe(false);
    if (result.ok) { return; }
    expect(result.code).toBe('invalid-input');
  });

  it('rejects an absolute path outside the workspace', async () => {
    const result = await readFile({ path: '/etc/passwd' });
    expect(result.ok).toBe(false);
    if (result.ok) { return; }
    expect(result.code).toBe('invalid-input');
  });

  it('rejects a symlink that points outside the workspace', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-source-outside-'));
    const secret = path.join(outside, 'secret.txt');
    fs.writeFileSync(secret, 'secret');
    try {
      fs.symlinkSync(secret, path.join(workspace, 'link.fluid.js'));
    } catch {
      // Some CI envs disallow symlinks; skip this assertion if so.
      fs.rmSync(outside, { recursive: true, force: true });
      return;
    }
    const result = await readFile({ path: 'link.fluid.js' });
    expect(result.ok).toBe(false);
    if (result.ok) {
      fs.rmSync(outside, { recursive: true, force: true });
      return;
    }
    expect(result.code).toBe('invalid-input');
    fs.rmSync(outside, { recursive: true, force: true });
  });
});

describe('write_file', () => {
  it('writes a new file atomically', async () => {
    const result = await writeFile({ path: 'new.fluid.js', content: 'sphere(5);' });
    expect(result.ok).toBe(true);
    expect(fs.readFileSync(path.join(workspace, 'new.fluid.js'), 'utf8')).toBe('sphere(5);');
  });

  it('overwrites an existing file', async () => {
    fs.writeFileSync(path.join(workspace, 'existing.fluid.js'), 'old');
    const result = await writeFile({ path: 'existing.fluid.js', content: 'new' });
    expect(result.ok).toBe(true);
    expect(fs.readFileSync(path.join(workspace, 'existing.fluid.js'), 'utf8')).toBe('new');
  });

  it('refuses to write to a dirty buffer without force', async () => {
    const target = path.join(workspace, 'dirty.fluid.js');
    fs.writeFileSync(target, 'original');
    dirtyFiles = [{ path: target, lastModifiedMs: Date.now() }];

    const result = await writeFile({ path: 'dirty.fluid.js', content: 'attempted overwrite' });
    expect(result.ok).toBe(false);
    if (result.ok) { return; }
    expect(result.code).toBe('dirty-buffer');
    expect((result.details as any)?.dirtyFiles).toContain(target);
    expect(fs.readFileSync(target, 'utf8')).toBe('original');
  });

  it('force: true overrides the dirty-buffer guard', async () => {
    const target = path.join(workspace, 'forced.fluid.js');
    fs.writeFileSync(target, 'original');
    dirtyFiles = [{ path: target, lastModifiedMs: Date.now() }];

    const result = await writeFile({ path: 'forced.fluid.js', content: 'overwrite', force: true });
    expect(result.ok).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toBe('overwrite');
  });

  it('rejects writes that escape the workspace', async () => {
    const result = await writeFile({ path: '../escape.fluid.js', content: 'pwned' });
    expect(result.ok).toBe(false);
    if (result.ok) { return; }
    expect(result.code).toBe('invalid-input');
  });
});

describe('edit_range', () => {
  it('replaces a contiguous range', async () => {
    const target = path.join(workspace, 'edit.fluid.js');
    fs.writeFileSync(target, 'line one\nline two\nline three\n');

    const result = await editRange({
      path: 'edit.fluid.js',
      start: { line: 1, column: 5 },
      end: { line: 1, column: 8 },
      newText: 'TWO',
    });
    expect(result.ok).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toBe('line one\nline TWO\nline three\n');
  });

  it('clamps a column past end-of-line', async () => {
    const target = path.join(workspace, 'eol.fluid.js');
    fs.writeFileSync(target, 'short\nlonger line\n');

    const result = await editRange({
      path: 'eol.fluid.js',
      start: { line: 0, column: 999 },
      end: { line: 0, column: 999 },
      newText: '!',
    });
    expect(result.ok).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toBe('short!\nlonger line\n');
  });

  it('clamps a line past end-of-file', async () => {
    const target = path.join(workspace, 'eof.fluid.js');
    fs.writeFileSync(target, 'only line\n');

    const result = await editRange({
      path: 'eof.fluid.js',
      start: { line: 99, column: 0 },
      end: { line: 99, column: 0 },
      newText: 'appended',
    });
    expect(result.ok).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toBe('only line\nappended');
  });

  it('refuses to edit a dirty file without force', async () => {
    const target = path.join(workspace, 'dirty.fluid.js');
    fs.writeFileSync(target, 'before');
    dirtyFiles = [{ path: target, lastModifiedMs: Date.now() }];

    const result = await editRange({
      path: 'dirty.fluid.js',
      start: { line: 0, column: 0 },
      end: { line: 0, column: 6 },
      newText: 'after',
    });
    expect(result.ok).toBe(false);
    if (result.ok) { return; }
    expect(result.code).toBe('dirty-buffer');
    expect(fs.readFileSync(target, 'utf8')).toBe('before');
  });

  it('rejects an inverted range', async () => {
    fs.writeFileSync(path.join(workspace, 'inv.fluid.js'), 'abc');
    const result = await editRange({
      path: 'inv.fluid.js',
      start: { line: 0, column: 2 },
      end: { line: 0, column: 1 },
      newText: 'x',
    });
    expect(result.ok).toBe(false);
    if (result.ok) { return; }
    expect(result.code).toBe('invalid-input');
  });
});

describe('list_fluid_files', () => {
  it('returns relative paths and skips ignored dirs', async () => {
    fs.writeFileSync(path.join(workspace, 'a.fluid.js'), '');
    fs.mkdirSync(path.join(workspace, 'sub'));
    fs.writeFileSync(path.join(workspace, 'sub', 'b.fluid.js'), '');
    fs.mkdirSync(path.join(workspace, 'node_modules'));
    fs.writeFileSync(path.join(workspace, 'node_modules', 'skip.fluid.js'), '');
    fs.mkdirSync(path.join(workspace, '.git'));
    fs.writeFileSync(path.join(workspace, '.git', 'no.fluid.js'), '');
    fs.writeFileSync(path.join(workspace, 'not-fluid.txt'), '');

    const result = await listFluidFiles({});
    expect(result.ok).toBe(true);
    if (!result.ok) { return; }
    expect(result.data.files.sort()).toEqual(['a.fluid.js', path.join('sub', 'b.fluid.js')].sort());
  });
});

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createFilesRouter } from '../../src/routes/files.ts';

// The file routes are the in-page editor's disk access. Two things are being
// checked here: that they round-trip a real workspace, and that WORKSPACE_PATH
// is a boundary — this server binds to localhost but anything on the machine
// can reach it.

let server: http.Server;
let baseUrl: string;
let workspace: string;
let opened: string[];
let written: { absPath: string; content: string }[];

async function get(route: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}/api${route}`);
  return { status: res.status, body: await res.json() };
}

async function post(route: string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}/api${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

describe('workspace file routes', () => {
  beforeAll(async () => {
    workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-files-')));

    const app = express();
    app.use(express.json());
    app.use('/api', createFilesRouter({
      workspacePath: workspace,
      openFile: async (absPath) => { opened.push(absPath); },
      onWrite: (absPath, content) => { written.push({ absPath, content }); },
    }));

    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address();
    baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  beforeEach(() => {
    opened = [];
    written = [];
    for (const entry of fs.readdirSync(workspace)) {
      fs.rmSync(path.join(workspace, entry), { recursive: true, force: true });
    }
  });

  describe('tree', () => {
    it('lists workspace files, models first, with kinds', async () => {
      fs.writeFileSync(path.join(workspace, 'helper.js'), 'export const a = 1;');
      fs.writeFileSync(path.join(workspace, 'bracket.fluid.js'), '// model');
      fs.mkdirSync(path.join(workspace, 'parts'));
      fs.writeFileSync(path.join(workspace, 'parts', 'plate.fluid.js'), '// part');

      const { status, body } = await get('/files/tree');
      expect(status).toBe(200);
      const byPath = Object.fromEntries(body.files.map((f: any) => [f.path, f]));
      expect(Object.keys(byPath).sort()).toEqual(['bracket.fluid.js', 'helper.js', 'parts/plate.fluid.js']);
      expect(byPath['bracket.fluid.js'].kind).toBe('model');
      expect(byPath['helper.js'].kind).toBe('source');
      expect(body.files[0].kind).toBe('model');
      expect(byPath['helper.js'].absPath).toBe(path.join(workspace, 'helper.js'));
    });

    it('classifies every fluid-script suffix as a model, not just .fluid.js', async () => {
      // `.part.js` / `.assembly.js` are the primary spellings (`file-kind.ts`);
      // the editor's tab icons, quick-open ordering and open-on-activate all
      // key off this kind, so an assembly file must not list as a helper.
      fs.writeFileSync(path.join(workspace, 'robot.assembly.js'), '// assembly');
      fs.writeFileSync(path.join(workspace, 'arm.part.js'), '// part');
      fs.writeFileSync(path.join(workspace, 'legacy.fluid.js'), '// part');
      fs.writeFileSync(path.join(workspace, 'assembly.js'), '// a helper that merely ends in the word');

      const { body } = await get('/files/tree');
      const byPath = Object.fromEntries(body.files.map((f: any) => [f.path, f]));
      expect(byPath['robot.assembly.js'].kind).toBe('model');
      expect(byPath['arm.part.js'].kind).toBe('model');
      expect(byPath['legacy.fluid.js'].kind).toBe('model');
      expect(byPath['assembly.js'].kind).toBe('source');
    });

    it('skips node_modules and .git without being told to', async () => {
      fs.mkdirSync(path.join(workspace, 'node_modules', 'fluidcad'), { recursive: true });
      fs.writeFileSync(path.join(workspace, 'node_modules', 'fluidcad', 'index.js'), '');
      fs.mkdirSync(path.join(workspace, '.git'), { recursive: true });
      fs.writeFileSync(path.join(workspace, '.git', 'config'), '');
      fs.writeFileSync(path.join(workspace, 'keep.fluid.js'), '');

      const { body } = await get('/files/tree');
      expect(body.files.map((f: any) => f.path)).toEqual(['keep.fluid.js']);
    });

    it('honours .gitignore, including a nested one', async () => {
      fs.writeFileSync(path.join(workspace, '.gitignore'), 'build/\n*.tmp.js\n');
      fs.mkdirSync(path.join(workspace, 'build'), { recursive: true });
      fs.writeFileSync(path.join(workspace, 'build', 'out.js'), '');
      fs.writeFileSync(path.join(workspace, 'scratch.tmp.js'), '');
      fs.mkdirSync(path.join(workspace, 'sub'), { recursive: true });
      fs.writeFileSync(path.join(workspace, 'sub', '.gitignore'), 'local.js\n');
      fs.writeFileSync(path.join(workspace, 'sub', 'local.js'), '');
      fs.writeFileSync(path.join(workspace, 'sub', 'shared.js'), '');

      const { body } = await get('/files/tree');
      const paths = body.files.map((f: any) => f.path).sort();
      expect(paths).toContain('sub/shared.js');
      expect(paths).not.toContain('build/out.js');
      expect(paths).not.toContain('scratch.tmp.js');
      expect(paths).not.toContain('sub/local.js');
    });
  });

  describe('read / write / create / rename / delete', () => {
    it('reports every write and create to onWrite so the disk-watcher echo can be recognised', async () => {
      await post('/files/write', { path: 'arm.part.js', content: '// v1' });
      await post('/files/create', { path: 'new.part.js', content: '// fresh' });
      await post('/files/create', { path: 'empty.js' });
      expect(written).toEqual([
        { absPath: path.join(workspace, 'arm.part.js'), content: '// v1' },
        { absPath: path.join(workspace, 'new.part.js'), content: '// fresh' },
        { absPath: path.join(workspace, 'empty.js'), content: '' },
      ]);
    });

    it('prefills a new assembly file with the assembly() wrapper', async () => {
      const { status } = await post('/files/create', { path: 'rig.assembly.js' });
      expect(status).toBe(200);
      const content = fs.readFileSync(path.join(workspace, 'rig.assembly.js'), 'utf8');
      expect(content).toContain(`import { assembly } from 'fluidcad/core';`);
      expect(content).toContain(`export const rig = assembly('rig', () => {`);
      // The prefill is what lands in the write ledger too, so the watcher
      // echo of the template is recognised as our own write.
      expect(written).toEqual([{ absPath: path.join(workspace, 'rig.assembly.js'), content }]);
    });

    it('keeps explicit content over the assembly prefill', async () => {
      await post('/files/create', { path: 'custom.assembly.js', content: '// mine' });
      expect(fs.readFileSync(path.join(workspace, 'custom.assembly.js'), 'utf8')).toBe('// mine');
    });

    it('round-trips a file by workspace-relative path', async () => {
      fs.writeFileSync(path.join(workspace, 'a.fluid.js'), 'const x = 1;');

      const read = await get('/files/read?path=a.fluid.js');
      expect(read.status).toBe(200);
      expect(read.body.content).toBe('const x = 1;');
      expect(read.body.kind).toBe('model');
      expect(typeof read.body.mtimeMs).toBe('number');

      const write = await post('/files/write', { path: 'a.fluid.js', content: 'const x = 2;' });
      expect(write.status).toBe(200);
      expect(fs.readFileSync(path.join(workspace, 'a.fluid.js'), 'utf8')).toBe('const x = 2;');
      expect(write.body.mtimeMs).toBeGreaterThanOrEqual(read.body.mtimeMs);
    });

    it('accepts an absolute path inside the workspace', async () => {
      fs.writeFileSync(path.join(workspace, 'abs.fluid.js'), 'ok');
      const abs = path.join(workspace, 'abs.fluid.js');
      const read = await get(`/files/read?path=${encodeURIComponent(abs)}`);
      expect(read.status).toBe(200);
      expect(read.body.content).toBe('ok');
    });

    it('creates parent directories on write', async () => {
      const { status } = await post('/files/write', { path: 'deep/nested/new.js', content: 'hi' });
      expect(status).toBe(200);
      expect(fs.readFileSync(path.join(workspace, 'deep/nested/new.js'), 'utf8')).toBe('hi');
    });

    it('404s a missing file and 409s a create over an existing one', async () => {
      expect((await get('/files/read?path=nope.fluid.js')).status).toBe(404);

      const created = await post('/files/create', { path: 'fresh.fluid.js' });
      expect(created.status).toBe(200);
      expect(fs.existsSync(path.join(workspace, 'fresh.fluid.js'))).toBe(true);

      const again = await post('/files/create', { path: 'fresh.fluid.js' });
      expect(again.status).toBe(409);
    });

    it('renames and deletes', async () => {
      fs.writeFileSync(path.join(workspace, 'old.fluid.js'), 'body');

      const renamed = await post('/files/rename', { path: 'old.fluid.js', newPath: 'new.fluid.js' });
      expect(renamed.status).toBe(200);
      expect(renamed.body.from).toBe('old.fluid.js');
      expect(fs.existsSync(path.join(workspace, 'old.fluid.js'))).toBe(false);
      expect(fs.readFileSync(path.join(workspace, 'new.fluid.js'), 'utf8')).toBe('body');

      const deleted = await post('/files/delete', { path: 'new.fluid.js' });
      expect(deleted.status).toBe(200);
      expect(fs.existsSync(path.join(workspace, 'new.fluid.js'))).toBe(false);
      expect((await post('/files/delete', { path: 'new.fluid.js' })).status).toBe(404);
    });

    it('renames without touching importers unless asked, and never over an existing file', async () => {
      fs.writeFileSync(path.join(workspace, 'bracket.part.js'), 'export const bracket = 1;\n');
      fs.writeFileSync(path.join(workspace, 'rig.assembly.js'), "import { bracket } from './bracket.part.js';\n");
      fs.writeFileSync(path.join(workspace, 'taken.part.js'), 'taken');

      const plain = await post('/files/rename', { path: 'bracket.part.js', newPath: 'arm.part.js' });
      expect(plain.status).toBe(200);
      expect(plain.body.imports).toBeUndefined();
      expect(fs.readFileSync(path.join(workspace, 'rig.assembly.js'), 'utf8')).toContain('./bracket.part.js');

      const clash = await post('/files/rename', { path: 'arm.part.js', newPath: 'taken.part.js', updateImports: true });
      expect(clash.status).toBe(409);
      expect(fs.readFileSync(path.join(workspace, 'taken.part.js'), 'utf8')).toBe('taken');
      expect(fs.existsSync(path.join(workspace, 'arm.part.js'))).toBe(true);

      expect((await post('/files/rename', { path: 'arm.part.js', newPath: 'arm.part.js' })).status).toBe(400);
      fs.mkdirSync(path.join(workspace, 'dir'));
      expect((await post('/files/rename', { path: 'dir', newPath: 'dir2' })).status).toBe(400);
      expect(fs.existsSync(path.join(workspace, 'dir'))).toBe(true);
    });

    it('updates importers on rename: clean files on disk, unsaved buffers by return value', async () => {
      fs.writeFileSync(path.join(workspace, 'bracket.part.js'), 'export const bracket = 1;\n');
      fs.writeFileSync(path.join(workspace, 'rig.assembly.js'), "import { bracket } from './bracket.part.js';\n");
      fs.mkdirSync(path.join(workspace, 'sub'));
      fs.writeFileSync(path.join(workspace, 'sub', 'other.js'), "import { bracket } from '../bracket.part.js';\n");
      fs.writeFileSync(path.join(workspace, 'broken.js'), "import { bracket } from './bracket.part.js';\nlet = ;\n");

      const { status, body } = await post('/files/rename', {
        path: 'bracket.part.js',
        newPath: 'parts/arm.part.js',
        updateImports: true,
        buffers: { 'sub/other.js': "// unsaved\nimport { bracket } from '../bracket.part.js';\n" },
      });
      expect(status).toBe(200);
      expect(body.from).toBe('bracket.part.js');
      expect(body.path).toBe('parts/arm.part.js');
      expect(fs.readFileSync(path.join(workspace, 'parts', 'arm.part.js'), 'utf8')).toBe('export const bracket = 1;\n');
      expect(fs.existsSync(path.join(workspace, 'bracket.part.js'))).toBe(false);

      expect(body.imports.truncated).toBe(false);
      expect(body.imports.skipped).toEqual([{ path: 'broken.js', reason: 'it has syntax errors' }]);
      expect(body.imports.updated.map((u: any) => [u.path, u.mtimeMs === null, u.replacements])).toEqual([
        ['rig.assembly.js', false, [{ from: './bracket.part.js', to: './parts/arm.part.js' }]],
        ['sub/other.js', true, [{ from: '../bracket.part.js', to: '../parts/arm.part.js' }]],
      ]);
      expect(fs.readFileSync(path.join(workspace, 'rig.assembly.js'), 'utf8')).toBe("import { bracket } from './parts/arm.part.js';\n");
      // The unsaved buffer's file stays as it was on disk; the rewritten text came back instead.
      expect(fs.readFileSync(path.join(workspace, 'sub', 'other.js'), 'utf8')).toBe("import { bracket } from '../bracket.part.js';\n");
      expect(body.imports.updated[1].content).toBe("// unsaved\nimport { bracket } from '../parts/arm.part.js';\n");
      // The file that couldn't be rewritten is exactly as it was.
      expect(fs.readFileSync(path.join(workspace, 'broken.js'), 'utf8')).toBe("import { bracket } from './bracket.part.js';\nlet = ;\n");
      // Both the moved model and the rewritten importer went through the ledger.
      expect(written.map((w) => path.relative(workspace, w.absPath)).sort()).toEqual(['parts/arm.part.js', 'rig.assembly.js']);
      expect(fs.readdirSync(workspace).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    });

    it('rejects a write whose content is not a string', async () => {
      const { status } = await post('/files/write', { path: 'a.js', content: { not: 'a string' } });
      expect(status).toBe(400);
    });
  });

  describe('open', () => {
    it('renders the file as the current model', async () => {
      fs.writeFileSync(path.join(workspace, 'open-me.fluid.js'), '');
      const { status, body } = await post('/files/open', { path: 'open-me.fluid.js' });
      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(opened).toEqual([path.join(workspace, 'open-me.fluid.js')]);
    });

    it('404s rather than rendering a file that does not exist', async () => {
      const { status } = await post('/files/open', { path: 'ghost.fluid.js' });
      expect(status).toBe(404);
      expect(opened).toEqual([]);
    });
  });

  describe('the workspace boundary', () => {
    const escapes = [
      '../../etc/passwd',
      '../outside.js',
      './sub/../../outside.js',
      '/etc/passwd',
    ];

    for (const attempt of escapes) {
      it(`refuses to read ${attempt}`, async () => {
        const { status, body } = await get(`/files/read?path=${encodeURIComponent(attempt)}`);
        expect(status).toBe(403);
        expect(body.error).toMatch(/outside the workspace/);
      });

      it(`refuses to write ${attempt}`, async () => {
        const { status } = await post('/files/write', { path: attempt, content: 'pwned' });
        expect(status).toBe(403);
      });
    }

    it('refuses a symlink that points out of the workspace', async () => {
      const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-outside-')));
      fs.writeFileSync(path.join(outside, 'secret.js'), 'secret');
      try {
        fs.symlinkSync(outside, path.join(workspace, 'link'));
      } catch {
        return; // Platforms without symlink permission (Windows CI) skip this.
      }

      const { status } = await get('/files/read?path=link/secret.js');
      expect(status).toBe(403);

      fs.rmSync(outside, { recursive: true, force: true });
    });

    it('refuses a rename whose destination escapes', async () => {
      fs.writeFileSync(path.join(workspace, 'inside.js'), '');
      const { status } = await post('/files/rename', { path: 'inside.js', newPath: '../escaped.js' });
      expect(status).toBe(403);
      expect(fs.existsSync(path.join(workspace, 'inside.js'))).toBe(true);
    });

    it('refuses the workspace root itself', async () => {
      const { status } = await get(`/files/read?path=${encodeURIComponent(workspace)}`);
      expect(status).toBe(403);
    });
  });
});

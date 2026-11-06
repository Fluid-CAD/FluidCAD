import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { createTimelineRouter } from '../../src/routes/timeline.ts';
import { createSketchEditsRouter } from '../../src/routes/sketch-edits.ts';
import { createFilesRouter } from '../../src/routes/files.ts';
import { FeatureEditDispatcher } from '../../src/edit-dispatch.ts';
import { PackageEditGuard, PackageReadOnlyError } from '../../src/packages/package-edit-guard.ts';
import { PackageRoots } from '../../src/packages/package-roots.ts';
import { collectEntryFiles } from '../../src/files/entry-files.ts';
import type { FluidCadServer } from '../../src/fluidcad-server/index.ts';
import type { ApplyFeatureEditSpec } from '../../src/apply-feature-edit/index.ts';
import { PackageProject } from './package-project.ts';

// Installed packages are read-only (K8): every edit aimed at one of their
// files is refused with one sentence, whichever path it takes — the edit
// dispatch, a route's own host message, a route with a side effect before
// its edit, or the file routes writing into a project copy. A fork of a
// package elsewhere in the workspace stays ordinary, editable code.

let project: PackageProject;
let kit: string;
let copy: string;
let current: string | null;
let relayed: any[];
let adopted: string[];
let server: http.Server;
let baseUrl: string;
let dispatcher: FeatureEditDispatcher;

const SENTENCE = '`parts/spacer.part.js` belongs to `@acme/kit` 0.1.0 and is read-only.';

async function post(route: string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}/api${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

function spec(filePath: string): ApplyFeatureEditSpec {
  return { feature: 'sketch', filePath, producers: [], parts: [], imports: [] };
}

beforeEach(async () => {
  project = new PackageProject('fluidcad-package-read-only-');
  ({ dir: kit } = await project.install('@acme/kit', '0.1.0'));
  ({ dir: copy } = await project.install('@acme/kit', '0.1.0', { target: 'project' }));
  project.config(null);
  project.write('model.part.js', 'export {};\n');
  // A user's own `packages/` code, and a fork that kept the package's manifest: both ordinary.
  project.write('packages/models/bracket.part.js', 'export {};\n');
  fs.cpSync(kit, project.at('vendor/kit'), { recursive: true });
  PackageProject.chmodFiles(project.at('vendor/kit'), 0o644);
  current = project.at('model.part.js');
  relayed = [];
  adopted = [];

  const fakeServer = {
    getCurrentCode: () => null,
    getCurrentFileName: () => current ?? '',
    getProjectMaterials: () => ({}),
    adoptProjectMaterial: (id: string) => {
      adopted.push(id);
      return project.at('fluidcad.json');
    },
  } as unknown as FluidCadServer;
  const guard = new PackageEditGuard(() => project.root, () => current);
  // Delivered to no host, so a dispatch answers at once (the legacy no-host success).
  const send = guard.guardSend((msg) => {
    relayed.push(msg);
    return false;
  });
  dispatcher = new FeatureEditDispatcher(fakeServer, send, { preflight: false, packages: guard });
  const app = express();
  app.use(express.json());
  app.use('/api', createTimelineRouter(fakeServer, send, () => {}, {
    dispatcher,
    loadGlobalMaterials: async () => ({ 'house-pla': { name: 'House PLA', density: 1.3 } }),
  }));
  app.use('/api', createSketchEditsRouter(fakeServer, send, project.root, dispatcher));
  app.use('/api', createFilesRouter({ workspacePath: project.root, openFile: async () => {} }));
  app.use('/api', PackageEditGuard.errorHandler());
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  project.dispose();
});

describe('PackageRoots.owner', () => {
  it('claims the files of an installed package, in the library and in the project copy, and nothing else', () => {
    expect(PackageRoots.owner(`${kit}/parts/spacer.part.js`, project.root)).toMatchObject({ name: '@acme/kit', version: '0.1.0', target: 'library' });
    expect(PackageRoots.owner(`${copy}/index.js`, project.root)).toMatchObject({ name: '@acme/kit', target: 'project' });
    expect(PackageRoots.owner(project.at('packages/models/bracket.part.js'), project.root)).toBeNull();
    expect(PackageRoots.owner(project.at('vendor/kit/parts/spacer.part.js'), project.root)).toBeNull();
    expect(PackageRoots.owner(project.at('model.part.js'), project.root)).toBeNull();
  });

  it('words the refusal by the package path of the file', () => {
    const owner = PackageRoots.owner(`${kit}/parts/spacer.part.js`, project.root)!;
    expect(PackageRoots.readOnlySentence(owner, `${kit}/parts/spacer.part.js`)).toBe(SENTENCE);
  });
});

describe('the edit dispatch', () => {
  it('refuses a spec aimed at a package file before anything is sent', async () => {
    expect(await dispatcher.send(spec(`${kit}/parts/spacer.part.js`))).toEqual({ error: SENTENCE });
    expect(await dispatcher.send(spec(`${copy}/parts/spacer.part.js`))).toEqual({ error: SENTENCE });
    expect(relayed).toEqual([]);
    // A workspace file, and a fork, go through.
    expect(await dispatcher.send(spec(project.at('model.part.js')))).toEqual({});
    expect(await dispatcher.send(spec(project.at('vendor/kit/parts/spacer.part.js')))).toEqual({});
    expect(relayed.map(msg => msg.spec.filePath)).toEqual([project.at('model.part.js'), project.at('vendor/kit/parts/spacer.part.js')]);
  });
});

describe('routes that take a source location', () => {
  it('set-part-material refuses a package part before copying the material into fluidcad.json', async () => {
    const before = fs.readFileSync(project.at('fluidcad.json'), 'utf8');
    const refused = await post('/set-part-material', { sourceLocation: { filePath: `${kit}/parts/spacer.part.js`, line: 7 }, material: 'house-pla' });
    expect(refused).toEqual({ status: 403, body: { success: false, reason: SENTENCE, code: 'package-read-only' } });
    expect(adopted).toEqual([]);
    expect(relayed).toEqual([]);
    expect(fs.readFileSync(project.at('fluidcad.json'), 'utf8')).toBe(before);

    const ok = await post('/set-part-material', { sourceLocation: { filePath: project.at('model.part.js'), line: 1 }, material: 'house-pla' });
    expect(ok.status).toBe(200);
    expect(adopted).toEqual(['house-pla']);
    expect(relayed).toHaveLength(1);
  });

  it('a breakpoint refuses a package file, through the host send', async () => {
    const refused = await post('/add-breakpoint', { sourceLocation: { filePath: `${copy}/parts/spacer.part.js`, line: 7 } });
    expect(refused.status).toBe(403);
    expect(refused.body.reason).toBe(SENTENCE);
    expect(relayed).toEqual([]);
    expect((await post('/add-breakpoint', { sourceLocation: { filePath: project.at('model.part.js'), line: 1 } })).status).toBe(200);
    expect(relayed.map(msg => msg.type)).toEqual(['add-breakpoint']);
  });

  it('a timeline rename and a sketch edit of an open package file are refused', async () => {
    const rename = await post('/rename-feature', { sourceLocation: { filePath: `${kit}/parts/spacer.part.js`, line: 8, column: 3 }, name: 'tube' });
    expect(rename.status).toBe(403);
    // A sketch edit names no file: it edits the open one.
    current = `${kit}/parts/spacer.part.js`;
    const point = await post('/insert-point', { point: [1, 2], sourceLocation: { line: 8, column: 3 } });
    expect(point.status).toBe(403);
    expect(point.body.reason).toBe(SENTENCE);
    expect(relayed).toEqual([]);
    current = project.at('model.part.js');
    expect((await post('/insert-point', { point: [1, 2], sourceLocation: { line: 1, column: 1 } })).status).toBe(200);
  });

  it('a message that edits no file passes, whatever is open', async () => {
    current = `${kit}/parts/spacer.part.js`;
    expect((await post('/clear-breakpoints', {})).status).toBe(200);
    expect(relayed.map(msg => msg.type)).toEqual(['clear-breakpoints']);
  });
});

describe('the file routes', () => {
  it('refuse writing, renaming or deleting inside a project copy, and allow the rest of packages/', async () => {
    const target = path.relative(project.root, `${copy}/parts/spacer.part.js`).replace(/\\/g, '/');
    const write = await post('/files/write', { path: target, content: 'export {};\n' });
    expect(write).toEqual({ status: 403, body: { error: SENTENCE } });
    expect((await post('/files/delete', { path: target })).status).toBe(403);
    expect((await post('/files/rename', { path: target, newPath: 'stolen.part.js' })).status).toBe(403);
    expect((await post('/files/create', { path: 'packages/@acme/kit/0.1.0/extra.part.js' })).status).toBe(403);
    expect(fs.existsSync(`${copy}/parts/spacer.part.js`)).toBe(true);

    expect((await post('/files/write', { path: 'packages/models/bracket.part.js', content: 'export const x = 1;\n' })).status).toBe(200);
    expect((await post('/files/write', { path: 'vendor/kit/parts/spacer.part.js', content: 'export {};\n' })).status).toBe(200);
  });
});

describe('PackageEditGuard', () => {
  it('names what a host message edits: the file it names, else the open file, and nothing for a non-edit', () => {
    const guard = new PackageEditGuard(() => project.root, () => '/ws/open.part.js');
    expect(guard.targetsOf({ type: 'apply-feature-edit', spec: { filePath: '/ws/a.part.js' } })).toEqual(['/ws/a.part.js']);
    expect(guard.targetsOf({ type: 'update-insert-chain', sourceLocation: { filePath: '/ws/b.assembly.js', line: 1 } })).toEqual(['/ws/b.assembly.js']);
    expect(guard.targetsOf({ type: 'update-dimension', sourceLocation: { line: 1, column: 1 } })).toEqual(['/ws/open.part.js']);
    expect(guard.targetsOf({ type: 'scene-rendered', absPath: '/ws/open.part.js' })).toEqual([]);
    expect(guard.targetsOf({ type: 'goto-source', filePath: '/ws/a.part.js', line: 1, column: 1 })).toEqual([]);
    expect(guard.refusal(`${kit}/index.js`)).toBeInstanceOf(PackageReadOnlyError);
    expect(guard.refusal(project.at('model.part.js'), null, undefined)).toBeNull();
  });
});

describe('share-by-link', () => {
  it('refuses a model that imports a pinned package, by name', async () => {
    project.config({ '@acme/kit': { version: '0.1.0', integrity: 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' } });
    project.write('uses-kit.part.js', `import { standoff } from '@acme/kit';\nexport const s = standoff;\n`);
    await expect(collectEntryFiles(project.at('uses-kit.part.js'), project.root)).rejects.toThrow(
      'Links can\'t carry packages yet (`@acme/kit`).',
    );
    // A model that imports no package still shares.
    expect(Object.keys(await collectEntryFiles(project.at('model.part.js'), project.root)).sort()).toEqual(['fluidcad.json', 'init.js', 'model.part.js']);
  });
});

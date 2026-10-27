import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import http from 'http';
import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { createPackagesRouter } from '../../src/routes/packages.ts';
import { PackageTypeLibs, PackageTypeShims } from '../../src/packages/package-editor-types.ts';
import { PackageTypeLinks } from '../../src/packages/package-type-links.ts';
import { PackageRoots } from '../../src/packages/package-roots.ts';
import { ProjectJsconfig } from '../../src/project-jsconfig.ts';
import { FluidCadServer } from '../../src/fluidcad-server/index.ts';
import { LocalSceneHost } from '../../src/host/local-scene-host.ts';
import { ENGINE_PACKAGE_ROOT } from '../../src/host/engine-resolution.ts';
import type { SceneRenderedData } from '../../src/fluidcad-server/render-types.ts';
import { PackageProject } from './package-project.ts';

// Editor types for pinned packages (Stage P8). The in-page editor gets the
// pins' sources from GET /api/packages/types under file:///node_modules/…;
// tsserver (VS Code, Neovim) gets a marked shim per pin in the project's
// node_modules/@types, linking to the installed directory, which the scene
// host keeps in step with the pins. Never node_modules/@scope/name: Vite
// would externalize the package there (K11). A temp project and a temp
// library (FLUIDCAD_PACKAGES) through PackageProject.

let project: PackageProject;
let servers: http.Server[];
let host: LocalSceneHost | null;

const KIT = '@acme/kit';
const SHIM = 'node_modules/@types/acme__kit';

async function pin(version = '0.1.0', target: 'library' | 'project' = 'library'): Promise<{ dir: string; integrity: string }> {
  const installed = await project.install(KIT, version, { target });
  project.config({ [KIT]: { version, integrity: installed.integrity } });
  return installed;
}

async function serve(): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use('/api', createPackagesRouter({ workspacePath: project.root }));
  const server = http.createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
}

async function getTypes(): Promise<{ status: number; body: any }> {
  const res = await fetch(`${await serve()}/packages/types`);
  return { status: res.status, body: await res.json() };
}

/** Every directory under the project's `node_modules`, project-relative, not following links. */
function nodeModulesDirs(): string[] {
  const found: string[] = [];
  const walk = (rel: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(project.at(rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        found.push(`${rel}/${entry.name}`);
        walk(`${rel}/${entry.name}`);
      }
    }
  };
  walk('node_modules');
  return found;
}

beforeEach(() => {
  project = new PackageProject('fluidcad-package-editor-types-');
  servers = [];
  host = null;
});

afterEach(async () => {
  await host?.server.close();
  for (const server of servers) {
    server.close();
  }
  project.dispose();
});

describe('GET /api/packages/types', () => {
  it('serves every .js file of each pinned package under file:///node_modules/@scope/name, nothing else', async () => {
    const { dir } = await pin();
    const { status, body } = await getTypes();

    expect(status).toBe(200);
    expect(body.files.map((file: { uri: string }) => file.uri)).toEqual([
      'file:///node_modules/@acme/kit/helpers/sizes.js',
      'file:///node_modules/@acme/kit/index.js',
      'file:///node_modules/@acme/kit/parts/spacer.part.js',
      'file:///node_modules/@acme/kit/standoff.feature.js',
    ]);
    for (const file of body.files) {
      const rel = file.uri.slice('file:///node_modules/@acme/kit/'.length);
      expect(file.content).toBe(fs.readFileSync(path.join(dir, rel), 'utf8'));
    }
    expect(body.bytes).toBe(body.files.reduce((sum: number, file: { content: string }) => sum + file.content.length, 0));
    expect(body.key).toContain('@acme/kit@0.1.0:');
  });

  it('serves nothing for a library package the project does not pin, nor for a pin installed nowhere', async () => {
    await project.install(KIT, '0.1.0');
    project.config(null);
    expect((await getTypes()).body).toMatchObject({ files: [], key: '' });

    project.config({ [KIT]: { version: '9.9.9', integrity: 'sha256-none' } });
    expect((await getTypes()).body).toMatchObject({ files: [], key: '' });
  });

  it('serves the project copy over the library, and says so in its key', async () => {
    await project.install(KIT, '0.1.0');
    const { integrity } = await project.install(KIT, '0.1.0', { target: 'project' });
    project.config({ [KIT]: { version: '0.1.0', integrity } });

    const fromProject = PackageTypeLibs.of(project.root);
    expect(fromProject.key).toContain(project.packageDir(KIT, '0.1.0', 'project'));
    expect(fromProject.files).toHaveLength(4);

    PackageProject.chmodFiles(project.packageDir(KIT, '0.1.0', 'project'), 0o644);
    fs.rmSync(project.at('packages'), { recursive: true });
    PackageRoots.forgetInstalled();
    const fromLibrary = PackageTypeLibs.of(project.root);
    expect(fromLibrary.key).toContain(project.packageDir(KIT, '0.1.0', 'library'));
    expect(fromLibrary.key).not.toBe(fromProject.key);
  });
});

describe('the tsserver shims', () => {
  it('writes a marked shim whose declaration re-exports the entry\'s modules through a link to the installed package', async () => {
    const { dir } = await pin();
    const sync = PackageTypeShims.sync(project.root);

    expect(sync).toMatchObject({ written: [KIT], kept: [], removed: [], skipped: [] });
    expect(fs.readFileSync(project.at(`${SHIM}/index.d.ts`), 'utf8')).toContain([
      `export { spacer } from "./installed/parts/spacer.part.js";`,
      `export { standoff } from "./installed/standoff.feature.js";`,
    ].join('\n'));
    expect(PackageTypeLinks.isShim(project.at(SHIM))).toBe(true);
    expect(fs.lstatSync(project.at(`${SHIM}/installed`)).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(project.at(`${SHIM}/installed`))).toBe(fs.realpathSync(dir));
    // A second sync with nothing changed writes nothing.
    expect(PackageTypeShims.sync(project.root)).toMatchObject({ written: [], kept: [KIT] });
  });

  it('never creates node_modules/@scope/name — only the @types shim', async () => {
    await pin();
    PackageTypeShims.sync(project.root);

    expect(nodeModulesDirs()).toEqual(['node_modules/@types', `${SHIM}`]);
    expect(fs.existsSync(project.at('node_modules/@acme'))).toBe(false);
  });

  it('re-points the link when the package moves into the project, and removes the shim of an unpinned package without touching the package', async () => {
    const library = await pin();
    PackageTypeShims.sync(project.root);
    const copy = await project.install(KIT, '0.1.0', { target: 'project' });
    PackageRoots.forgetInstalled();

    expect(PackageTypeShims.sync(project.root)).toMatchObject({ written: [KIT] });
    expect(fs.realpathSync(project.at(`${SHIM}/installed`))).toBe(fs.realpathSync(copy.dir));

    project.config(null);
    expect(PackageTypeShims.sync(project.root)).toMatchObject({ removed: [KIT], written: [] });
    expect(fs.existsSync(project.at(SHIM))).toBe(false);
    // The folder the first shim created goes with the last one.
    expect(fs.existsSync(project.at('node_modules/@types'))).toBe(false);
    // Unlinked, never followed: both installed copies are whole.
    expect(fs.readdirSync(library.dir).sort()).toEqual(['fluidcad.json', 'helpers', 'index.js', 'manifest.json', 'parts', 'standoff.feature.js', 'standoff.svg']);
    expect(fs.existsSync(path.join(copy.dir, 'parts/spacer.part.js'))).toBe(true);
  });

  it('removes the shim of a pin whose package is installed nowhere, and brings it back once it is', async () => {
    await pin();
    PackageTypeShims.sync(project.root);
    const dir = project.packageDir(KIT, '0.1.0');
    PackageProject.chmodFiles(dir, 0o644);
    fs.rmSync(dir, { recursive: true });
    PackageRoots.forgetInstalled();

    expect(PackageTypeShims.sync(project.root)).toMatchObject({ removed: [KIT] });
    await project.install(KIT, '0.1.0');
    PackageRoots.forgetInstalled();
    expect(PackageTypeShims.sync(project.root)).toMatchObject({ written: [KIT] });
  });

  it('leaves an @types folder of the same name that is not FluidCAD\'s, and other shims\' neighbours', async () => {
    await pin();
    project.write(`${SHIM}/index.d.ts`, 'export declare const npmOwned: number;\n');
    project.write('node_modules/@types/node/index.d.ts', '// someone else\'s\n');

    expect(PackageTypeShims.sync(project.root).skipped).toEqual([
      { folder: 'acme__kit', reason: expect.stringContaining('is not FluidCAD\'s') },
    ]);
    expect(fs.readFileSync(project.at(`${SHIM}/index.d.ts`), 'utf8')).toBe('export declare const npmOwned: number;\n');

    project.config(null);
    PackageTypeShims.sync(project.root);
    expect(fs.existsSync(project.at(`${SHIM}/index.d.ts`))).toBe(true);
    expect(fs.existsSync(project.at('node_modules/@types/node/index.d.ts'))).toBe(true);
  });

  it('re-exports the entry whole when the manifest names something it can\'t write', async () => {
    const { integrity } = await project.install(KIT, '0.1.0', {
      edit: (dir) => {
        const file = path.join(dir, 'manifest.json');
        const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
        manifest.features[0].exportName = 'standoff } from "x"; export {';
        fs.writeFileSync(file, JSON.stringify(manifest));
      },
    });
    project.config({ [KIT]: { version: '0.1.0', integrity } });
    PackageTypeShims.sync(project.root);

    const declaration = fs.readFileSync(project.at(`${SHIM}/index.d.ts`), 'utf8');
    expect(declaration).toContain('export * from "./installed/index.js";');
    expect(declaration).not.toContain('from "x"');
  });

  it('names a file reached through the link as the package\'s own, read-only and managed', async () => {
    await pin();
    PackageTypeShims.sync(project.root);
    const throughLink = project.at(`${SHIM}/installed/parts/spacer.part.js`);

    const owner = PackageRoots.owner(throughLink, project.root);
    expect(owner).toMatchObject({ name: KIT, version: '0.1.0', target: 'library' });
    expect(PackageRoots.readOnlySentence(owner!, throughLink)).toBe('`parts/spacer.part.js` belongs to `@acme/kit` 0.1.0 and is read-only.');
    expect(PackageRoots.isManaged(throughLink, project.root)).toBe(true);
    // A look-alike path with no marker is nobody's.
    project.write('node_modules/@types/fake__kit/installed/parts/spacer.part.js', '');
    expect(PackageRoots.owner(project.at('node_modules/@types/fake__kit/installed/parts/spacer.part.js'), project.root)).toBeNull();
  });
});

describe('tsserver through the shim, under the jsconfig fluidcad init writes', () => {
  const MODEL = [
    `import { extrude } from 'fluidcad/core';`,
    `import { standoff, spacer } from '@acme/kit';`,
    ``,
    `const pad = extrude(4);`,
    `standoff(pad.endFaces(), { height: 3 });`,
    `standoff(pad.endFaces(), { hieght: 8 });`,
    `export const s = spacer;`,
    ``,
  ].join('\n');

  /** A language service over the project, its options parsed from its jsconfig.json the way tsserver parses them. */
  function languageService(): ts.LanguageService {
    const configPath = project.at('jsconfig.json');
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, project.root, undefined, configPath);
    return ts.createLanguageService({
      getScriptFileNames: () => parsed.fileNames,
      getScriptVersion: () => '1',
      getScriptSnapshot: (file) => (ts.sys.fileExists(file) ? ts.ScriptSnapshot.fromString(ts.sys.readFile(file)!) : undefined),
      getCurrentDirectory: () => project.root,
      getCompilationSettings: () => parsed.options,
      getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
      fileExists: ts.sys.fileExists,
      readFile: ts.sys.readFile,
      readDirectory: ts.sys.readDirectory,
      directoryExists: ts.sys.directoryExists,
      getDirectories: ts.sys.getDirectories,
      realpath: ts.sys.realpath,
    });
  }

  beforeEach(async () => {
    // The project as `fluidcad init` and the engine link leave it.
    project.write('jsconfig.json', ProjectJsconfig.text());
    fs.mkdirSync(project.at('node_modules'), { recursive: true });
    fs.symlinkSync(ENGINE_PACKAGE_ROOT, project.at('node_modules/fluidcad'), 'junction');
    project.write('model.part.js', MODEL);
    await pin();
    PackageTypeShims.sync(project.root);
  });

  it('infers the package\'s feature from its JavaScript, flags a misspelled option, and goes to the installed file', () => {
    const service = languageService();
    const file = project.at('model.part.js');
    const at = MODEL.indexOf('standoff(pad') + 2;

    const hover = ts.displayPartsToString(service.getQuickInfoAtPosition(file, at)?.displayParts);
    expect(hover).toContain('(alias) standoff(args_0: ISelection');
    expect(hover).toContain('height?: number');
    expect(service.getSemanticDiagnostics(file).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))).toEqual([
      expect.stringContaining('\'hieght\' does not exist in type'),
    ]);
    const definition = service.getDefinitionAtPosition(file, at)!;
    expect(definition.map((d) => d.fileName)).toEqual([project.at(`${SHIM}/installed/standoff.feature.js`)]);
    // The package's own engine imports resolved from the project: no errors in its file.
    expect(service.getSemanticDiagnostics(project.at(`${SHIM}/installed/standoff.feature.js`))).toEqual([]);
  });

  it('follows the package\'s helper modules at the jsconfig\'s depth, which a jsconfig\'s default of 2 stops short of', () => {
    const helper = project.at(`${SHIM}/installed/helpers/sizes.js`);
    expect(languageService().getProgram()!.getSourceFile(helper)).toBeDefined();

    project.write('jsconfig.json', JSON.stringify({ compilerOptions: { checkJs: true, module: 'node20' } }));
    const shallow = languageService().getProgram()!;
    expect(shallow.getSourceFile(helper)).toBeUndefined();
    // The features and parts themselves are still typed at the default.
    expect(shallow.getSourceFile(project.at(`${SHIM}/installed/standoff.feature.js`))).toBeDefined();
  });
});

describe('the scene host keeps the shims', () => {
  /** A 40 × 30 plate, 5 thick, and the package's standoff on it. */
  const MODEL = [
    `import { standoff } from '@acme/kit';`,
    `import { Feature } from './probe.js';`,
    `import { extrude, line, sketch } from 'fluidcad/core';`,
    `import { coincident, fix } from 'fluidcad/constraints';`,
    ``,
    `sketch('xy', () => {`,
    `  const a = line([0, 0], [40, 0]); const b = line([40, 0], [40, 30]); const c = line([40, 30], [0, 30]); const d = line([0, 30], [0, 0]);`,
    `  coincident(a.end(), b.start()); coincident(b.end(), c.start()); coincident(c.end(), d.start()); coincident(d.end(), a.start());`,
    `  fix(a.start(), [0, 0]); fix(b.start(), [40, 0]); fix(c.start(), [40, 30]); fix(d.start(), [0, 30]);`,
    `});`,
    `const pad = extrude(5);`,
    `standoff(pad.endFaces(), { height: 12 });`,
    ``,
  ].join('\n');

  async function start(options: { linkEngine?: boolean } = {}): Promise<FluidCadServer> {
    host = new LocalSceneHost(undefined, options);
    const server = new FluidCadServer(host);
    await server.init(project.root);
    return server;
  }

  /** Run `fn` with the server's own render log silenced. */
  async function quietly<T>(fn: () => Promise<T>): Promise<T> {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      return await fn();
    } finally {
      log.mockRestore();
    }
  }

  beforeEach(() => {
    project.write('probe.js', `export { Feature } from 'fluidcad/sdk';\n`);
    project.write('model.part.js', MODEL);
  });

  it('writes the shim at start, and with it in place the package still loads inline through the resolver: one kernel', async () => {
    const { dir } = await pin();
    const server = await start();
    expect(PackageTypeLinks.isShim(project.at(SHIM))).toBe(true);

    const data = await quietly(() => server.updateLiveCode(project.at('model.part.js'), MODEL)) as SceneRenderedData;
    const rows = data.result as { type: string; hasError?: boolean; errorMessage?: string; sourceLocation?: { filePath: string } }[];
    expect(rows.filter((row) => row.hasError).map((row) => `${row.type}: ${row.errorMessage}`)).toEqual([]);
    expect(rows.some((row) => row.type === '@acme/kit:acme.standoff')).toBe(true);
    // Loaded from the installed directory, never through node_modules.
    expect(host!.resolvedPackages().map((p) => p.directory)).toEqual([dir]);
    expect(rows.some((row) => row.sourceLocation?.filePath.includes('/node_modules/'))).toBe(false);
    const pkg = await host!.loadModuleRaw(path.join(dir, 'standoff.feature.js'));
    const probe = await host!.loadModuleRaw(project.at('probe.js'));
    expect(pkg.Standoff.prototype).toBeInstanceOf(probe.Feature);
  });

  it('follows the pins on the next render and when fluidcad.json changes', async () => {
    const { integrity } = await pin();
    const server = await start();
    project.config(null);
    server.refreshEditorTypes();
    expect(fs.existsSync(project.at(SHIM))).toBe(false);

    project.config({ [KIT]: { version: '0.1.0', integrity } });
    await quietly(() => server.updateLiveCode(project.at('model.part.js'), MODEL));
    expect(PackageTypeLinks.isShim(project.at(SHIM))).toBe(true);
  });

  it('writes no shim for a host that must leave the workspace alone', async () => {
    await pin();
    await start({ linkEngine: false });
    expect(fs.existsSync(project.at('node_modules'))).toBe(false);
  });
});

import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import type { DevEnvironment } from 'vite';
import { EngineImportResolver } from '../src/host/engine-import-resolver.ts';
import { ENGINE_PACKAGE_ROOT } from '../src/host/engine-resolution.ts';
import { LocalSceneHost } from '../src/host/local-scene-host.ts';

/**
 * Loading a model must never depend on the engine writing into the project.
 * Issue #66: the AppImage opened a project on a `/mnt` drive whose filesystem
 * holds no symlinks, `ensureEngineLink` failed with EPERM, and the model died
 * with "Cannot find module 'fluidcad'". The resolver answers that import from
 * the engine itself; these tests pin both the answer and the seam it rides on.
 */

const ROOT = fs.realpathSync(ENGINE_PACKAGE_ROOT);
const EXPORTS: Record<string, string> = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'),
).exports;

function epermSymlink(): never {
  const err: any = new Error("EPERM: operation not permitted, symlink 'engine' -> 'workspace/node_modules/fluidcad'");
  err.code = 'EPERM';
  throw err;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('EngineImportResolver', () => {
  const resolver = new EngineImportResolver(ROOT);

  it('resolves the root and every exported subpath to this engine\'s own files', () => {
    for (const [subpath, target] of Object.entries(EXPORTS)) {
      if (subpath.endsWith('.css')) {
        continue; // Not a module; the runner never asks for it.
      }
      const specifier = subpath === '.' ? 'fluidcad' : `fluidcad/${subpath.slice(2)}`;
      expect(resolver.resolveFile(specifier)).toBe(fs.realpathSync(path.join(ROOT, target)));
    }
  });

  it('externalizes to a file URL the runner hands to Node, as Vite itself would', () => {
    expect(resolver.fetch('fluidcad/core')).toEqual({
      externalize: pathToFileURL(fs.realpathSync(path.join(ROOT, 'lib/dist/core/index.js'))).href,
      type: 'module',
    });
  });

  it('claims nothing but the engine', () => {
    for (const specifier of ['three', './model.js', '/abs/model.js', 'fluidcad-extras', 'virtual:live-render:x']) {
      expect(resolver.fetch(specifier)).toBeNull();
    }
  });

  it('refuses a subpath the package does not export, like every other resolver', () => {
    expect(() => resolver.resolveFile('fluidcad/lib/dist/index.js')).toThrow(/not defined by "exports"/);
  });

  it('installs on the environment\'s fetch and leaves every other request to Vite', async () => {
    const viteFetch = vi.fn(async (id: string) => ({ id, type: 'module' as const }));
    const environment = { fetchModule: viteFetch } as unknown as DevEnvironment;
    resolver.install(environment);

    await expect(environment.fetchModule('fluidcad', '/ws/init.js')).resolves.toEqual(resolver.fetch('fluidcad'));
    expect(viteFetch).not.toHaveBeenCalled();

    await expect(environment.fetchModule('./model.js', '/ws/init.js', { cached: true })).resolves.toEqual({
      id: './model.js',
      type: 'module',
    });
    expect(viteFetch).toHaveBeenCalledWith('./model.js', '/ws/init.js', { cached: true });
  });
});

describe('a workspace whose node_modules cannot hold a link (issue #66)', () => {
  it('still loads a model through the real host, with the engine answering the import', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-linkless-'));
    fs.writeFileSync(
      path.join(workspace, 'model.js'),
      "import * as engine from 'fluidcad';\n" +
        "import { sketch } from 'fluidcad/core';\n" +
        "export const kinds = { init: typeof engine.init, sketch: typeof sketch };\n",
    );
    const symlink = vi.spyOn(fs, 'symlinkSync').mockImplementation(epermSymlink);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const host = new LocalSceneHost();
    try {
      await host.init(workspace);
      // The link was attempted and refused — the exact failure of the report.
      expect(symlink).toHaveBeenCalled();
      expect(fs.existsSync(path.join(workspace, 'node_modules', 'fluidcad'))).toBe(false);
      expect(warn.mock.calls[0]?.[0]).toMatch(/could not link the engine.*EPERM/);

      // …and the model still resolves both the root and a subpath.
      const mod = await host.loadModuleRaw(path.join(workspace, 'model.js'));
      expect(mod.kinds).toEqual({ init: 'function', sketch: 'function' });

      // What it loaded is the server's own copy: the identity check compares this.
      expect(host.steeredEngineEntry()).toBe(fs.realpathSync(path.join(ROOT, 'lib/dist/index.js')));
    } finally {
      await host.server.close();
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('leaves a workspace with its own install to resolve itself', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-own-install-'));
    const dist = path.join(workspace, 'node_modules', 'fluidcad', 'lib', 'dist');
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(path.join(dist, 'index.js'), 'export const marker = true;\n');

    const host = new LocalSceneHost();
    try {
      await host.init(workspace);
      expect(host.steeredEngineEntry()).toBeNull();
    } finally {
      await host.server.close();
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});

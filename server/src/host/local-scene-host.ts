import { type ViteDevServer, createServer } from 'vite';
import { realpathSync } from 'fs';
import { dirname, resolve, isAbsolute } from 'path';
import { normalizePath } from '../normalize-path.ts';
import type { LoadModuleOptions, SceneHost } from './scene-host.ts';
import { isAssemblyDefinition, isPartDefinition } from './scene-host.ts';
import { getBlockedNodeModule } from './blocked-imports.ts';
import {
  ENGINE_PACKAGE_ROOT,
  NO_WORKSPACE_REASON,
  ensureEngineLink,
  runtimeUsesThisEngine,
} from './engine-resolution.ts';
import { EngineImportResolver } from './engine-import-resolver.ts';
import { installSourceUrlEncoding } from './source-url-encoding.ts';

const IMPORT_PATTERN = /\b(?:import|export)\s[\s\S]*?from\s+['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function scanForBlockedImports(code: string): string | null {
  let match;
  IMPORT_PATTERN.lastIndex = 0;
  while ((match = IMPORT_PATTERN.exec(code)) !== null) {
    const specifier = match[1] || match[2];
    const blocked = getBlockedNodeModule(specifier);
    if (blocked) {
      return specifier;
    }
  }
  return null;
}

export class LocalSceneHost implements SceneHost {
  server!: ViteDevServer;
  private rootPath: string = '';
  /** {@link rootPath} read through symlinks, for {@link isWorkspaceModule}. */
  private realRootPath: string = '';
  private buffers: Map<string, string> = new Map();
  /** Set when this engine answers the workspace's `import 'fluidcad'` itself. */
  private engineImports: EngineImportResolver | null = null;

  async init(rootPath: string) {
    this.rootPath = normalizePath(rootPath);
    this.realRootPath = LocalSceneHost.realpathOrSelf(this.rootPath);
    const that = this;
    // A workspace with no engine install of its own gets a marked
    // `node_modules/fluidcad` link to this server's copy, for the tools that
    // read the filesystem — see `engine-resolution.ts`. A no-op for every
    // workspace that has one. Loading the model does not depend on it: the
    // resolver installed below answers the import whether or not the link
    // could be made.
    const link = ensureEngineLink(this.rootPath);
    if (link.state === 'skipped' && link.reason !== NO_WORKSPACE_REASON) {
      console.warn(
        `FluidCAD: could not link the engine into this workspace (${link.reason}). ` +
          'Models still load through the running engine.',
      );
    }
    this.engineImports = runtimeUsesThisEngine(link) ? new EngineImportResolver(ENGINE_PACKAGE_ROOT) : null;
    this.server = await createServer({
      root: rootPath,
      resolve: {
        // Module ids keep the path a script was loaded by instead of its
        // real path. Source locations are those ids, and the routes compare
        // them with the file the render was asked for (`getCurrentFileName`)
        // and the editors hold — a workspace reached through a symlink
        // (macOS's /var and /tmp, a linked projects folder) would otherwise
        // name every feature by a path no client knows.
        preserveSymlinks: true
      },
      server: {
        watch: {
          ignoreInitial: true,
          ignored: ['**/node_modules/**']
        }
      },
      optimizeDeps: {
        noDiscovery: true,
        include: []
      },
      ssr: {
        // Externalized so Node loads the kernel once, as itself: routing it
        // through Vite's SSR pipeline would make a second copy of the
        // module-scoped param registry and BreakpointHit (Invariant 1).
        // This must stay unconditional — dev SSR ignores a plugin's
        // `external: true` and would inline the kernel through the module
        // runner, which is precisely that second copy.
        external: ['fluidcad']
      },
      plugins: [
        {
          name: 'virtual-module',
          resolveId(id, importer) {
            if (id.startsWith('virtual:')) {
              return id;
            }
            // Resolve relative imports from virtual modules against the real file path
            if (importer && importer.startsWith('virtual:live-render:') && !isAbsolute(id)) {
              const realImporter = importer.replace('virtual:live-render:', '');
              return normalizePath(resolve(dirname(realImporter), id));
            }
          },
          transform(code, id) {
            if (that.isWorkspaceModule(id) || id.startsWith('virtual:live-render')) {
              const blocked = scanForBlockedImports(code);
              if (blocked) {
                const moduleName = getBlockedNodeModule(blocked)!;
                throw new Error(
                  `Module "${blocked}" is not allowed in FluidCAD scripts. ` +
                  `Access to Node.js "${moduleName}" module is restricted for security.`
                );
              }
            }
          },
          load(id) {
            if (id.startsWith('virtual:live-render')) {
              let mod = this.getModuleInfo(id);
              if (mod) {
                that.server.moduleGraph.invalidateModule(
                  that.server.moduleGraph.getModuleById(id)!
                );
              }

              return that.buffers.get(id) || '';
            }
            else if (that.buffers.has(`virtual:live-render:${id}`)) {
              return that.buffers.get(`virtual:live-render:${id}`);
            }
          }
        }
      ]
    });
    this.engineImports?.install(this.server.environments.ssr);
    installSourceUrlEncoding(this.server.environments.ssr);
  }

  /**
   * Whether a module Vite is about to transform is one of the workspace's own
   * scripts, the ones the blocked-import scan guards. Judged by the path as
   * written and by its real path: a script loaded by another spelling of the
   * workspace folder (through a symlink, or by its real path when the
   * workspace was opened through one) is still the workspace's, and must not
   * slip past the scan.
   */
  private isWorkspaceModule(id: string): boolean {
    const file = id.split('?')[0];
    if (LocalSceneHost.isUnder(file, this.rootPath)) {
      return true;
    }
    return LocalSceneHost.isUnder(LocalSceneHost.realpathOrSelf(file), this.realRootPath);
  }

  /** Inside `root` and not in an npm dependency under it. */
  private static isUnder(file: string, root: string): boolean {
    return file.startsWith(root.endsWith('/') ? root : root + '/') && !file.includes('/node_modules/');
  }

  private static realpathOrSelf(file: string): string {
    try {
      return normalizePath(realpathSync(file));
    } catch {
      return file;
    }
  }

  steeredEngineEntry(): string | null {
    return this.engineImports?.resolveFile('fluidcad') ?? null;
  }

  setBuffer(id: string, code: string) {
    this.buffers.set(id, code);
  }

  getBuffer(fileName: string): string | null {
    return this.buffers.get(`virtual:live-render:${fileName}`) ?? null;
  }

  async loadModule(filePath: string, options: LoadModuleOptions = {}) {
    const mod = await this.server.ssrLoadModule(filePath);
    // Every export resolved first (a factory called for what it returns),
    // so the render can refuse the parts the module does not export before
    // any export builds.
    const exports: [string, unknown][] = [];
    for (const [name, value] of Object.entries(mod)) {
      exports.push([name, typeof value === 'function' ? await value() : value]);
    }
    options.onExports?.(exports);
    for (const [, result] of exports) {
      // assembly() definitions are LAZY — an exported factory (or a direct
      // definition export) creates no scene records until run. Entry-file
      // renders execute the definition at ROOT scope, so its `.grounded()`
      // declarations apply natively — this is what makes standalone editing
      // of a sub-assembly file work without a "grounded" parameter hack.
      if (isAssemblyDefinition(result)) {
        result.run();
      }
      // part() definitions are lazy too — exported ones materialize their
      // default variant so the defining file renders standalone (the
      // definition's own variant cache dedupes when an insert already
      // built it).
      if (isPartDefinition(result)) {
        result.materialize();
      }
    }
    return mod;
  }

  async loadModuleRaw(filePath: string) {
    return this.server.ssrLoadModule(filePath);
  }

  getModuleDependencies(filePath: string): string[] {
    const normalized = normalizePath(filePath);
    // Live-rendered entries sit in the graph under their virtual overlay id,
    // not the real path — try both so dependency queries work for files that
    // were only ever rendered from an editor buffer.
    const entry = this.server.moduleGraph.idToModuleMap.get(normalized)
      ?? this.server.moduleGraph.getModuleById(normalized)
      ?? this.server.moduleGraph.getModuleById(`virtual:live-render:${normalized}`);
    if (!entry) {
      return [];
    }
    const seen = new Set<string>();
    const queue = [entry];
    while (queue.length > 0) {
      const mod = queue.pop()!;
      // A virtual entry's id carries the overlay prefix — strip it so the
      // entry resolves to its real workspace path and its imports are walked.
      const file = (mod.file ?? mod.id ?? '').replace('virtual:live-render:', '');
      if (!file || seen.has(file)) {
        continue;
      }
      // Only workspace files gate the cache — node_modules churn is invisible
      // to mtime checks anyway (Vite externalizes fluidcad) and never holds
      // user parts.
      if (!file.startsWith(this.rootPath) || file.includes('/node_modules/')) {
        continue;
      }
      seen.add(file);
      const imported = (mod as any).ssrImportedModules ?? mod.importedModules;
      if (imported) {
        for (const dep of imported) {
          queue.push(dep);
        }
      }
    }
    return Array.from(seen);
  }


  invalidateModule() {
    for (const [id, mod] of this.server.moduleGraph.idToModuleMap) {
      if ((id.startsWith(this.rootPath) && !id.includes('/node_modules/')) || id.startsWith('virtual:live-render')) {
        this.server.moduleGraph.invalidateModule(mod);
      }
    }
  }
}

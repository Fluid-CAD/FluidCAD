import { type ViteDevServer, createServer } from 'vite';
import { dirname, resolve, isAbsolute } from 'path';
import { normalizePath } from '../normalize-path.ts';
import type { SceneHost } from './scene-host.ts';
import { isAssemblyDefinition } from './scene-host.ts';
import { getBlockedNodeModule } from './blocked-imports.ts';

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
  private buffers: Map<string, string> = new Map();

  async init(rootPath: string) {
    this.rootPath = normalizePath(rootPath);
    const that = this;
    this.server = await createServer({
      root: rootPath,
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
            if ((id.startsWith(that.rootPath) && !id.includes('/node_modules/')) || id.startsWith('virtual:live-render')) {
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
  }

  setBuffer(id: string, code: string) {
    this.buffers.set(id, code);
  }

  getBuffer(fileName: string): string | null {
    return this.buffers.get(`virtual:live-render:${fileName}`) ?? null;
  }

  async loadModule(filePath: string) {
    const mod = await this.server.ssrLoadModule(filePath);
    for (const value of Object.values(mod)) {
      let result: unknown = value;
      if (typeof value === 'function') {
        result = await value();
      }
      // assembly() definitions are LAZY — an exported factory (or a direct
      // definition export) creates no scene records until run. Entry-file
      // renders execute the definition at ROOT scope, so its `.grounded()`
      // declarations apply natively — this is what makes standalone editing
      // of a sub-assembly file work without a "grounded" parameter hack.
      if (isAssemblyDefinition(result)) {
        result.run();
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

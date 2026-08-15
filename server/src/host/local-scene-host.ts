import { type ViteDevServer, createServer } from 'vite';
import { dirname, resolve, isAbsolute } from 'path';
import { pathToFileURL } from 'url';
import { normalizePath } from '../normalize-path.ts';
import type { SceneHost } from './scene-host.ts';
import { getBlockedNodeModule } from './blocked-imports.ts';
import { engineSelfLinks } from './engine-resolution.ts';

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
    // Null for a workspace that installs its own engine — the normal npm case,
    // where nothing about resolution changes. See `engine-resolution.ts`.
    const selfLinks = engineSelfLinks(this.rootPath);
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
        // Externalized so Node loads the kernel once, as itself: routing it
        // through Vite's SSR pipeline would make a second copy of the
        // module-scoped param registry and BreakpointHit (Invariant 1).
        // When `selfLinks` is active the plugin below externalizes it by
        // absolute path instead, which is the same thing said more precisely.
        external: selfLinks ? [] : ['fluidcad']
      },
      plugins: [
        {
          name: 'fluidcad-engine-self-resolve',
          enforce: 'pre',
          resolveId(id) {
            const target = selfLinks?.get(id);
            if (target) {
              // A file URL, not a path: this is handed to Node's `import()`,
              // and it must be the very file the server already loaded.
              return { id: pathToFileURL(target).href, external: true };
            }
          }
        },
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
      if (typeof value === 'function') {
        await value();
      }
    }
    return mod;
  }


  invalidateModule() {
    for (const [id, mod] of this.server.moduleGraph.idToModuleMap) {
      if ((id.startsWith(this.rootPath) && !id.includes('/node_modules/')) || id.startsWith('virtual:live-render')) {
        this.server.moduleGraph.invalidateModule(mod);
      }
    }
  }
}

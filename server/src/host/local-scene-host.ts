import { type ViteDevServer, createServer } from 'vite';
import { dirname, resolve, isAbsolute } from 'path';
import { normalizePath } from '../normalize-path.ts';
import type { SceneHost } from './scene-host.ts';
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

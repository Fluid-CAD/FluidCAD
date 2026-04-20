import { type ViteDevServer, createServer } from 'vite';
import { dirname, resolve, isAbsolute } from 'path';
import { normalizePath } from './normalize-path.ts';

const BLOCKED_NODE_MODULES = new Set([
  'fs',
  'child_process',
  'net',
  'dgram',
  'tls',
  'http',
  'https',
  'http2',
  'os',
  'worker_threads',
  'vm',
  'cluster',
  'dns',
  'module',
]);

function getBlockedNodeModule(id: string): string | null {
  let name = id;
  if (name.startsWith('node:')) {
    name = name.slice(5);
  }
  const baseName = name.split('/')[0];
  return BLOCKED_NODE_MODULES.has(baseName) ? baseName : null;
}

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

export class ViteManager {
  server: ViteDevServer;
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
                  that.server.moduleGraph.getModuleById(id)
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

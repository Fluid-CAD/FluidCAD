import { type ViteDevServer, createServer } from 'vite';
import { dirname, resolve, isAbsolute } from 'path';

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

export class ViteManager {
  server: ViteDevServer;
  private rootPath: string = '';
  private buffers: Map<string, string> = new Map();

  async init(rootPath: string) {
    this.rootPath = rootPath;
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
      plugins: [
        {
          name: 'virtual-module',
          resolveId(id, importer) {
            const blockedModule = getBlockedNodeModule(id);
            if (blockedModule) {
              throw new Error(
                `Module "${id}" is not allowed in FluidCAD scripts. ` +
                `Access to Node.js "${blockedModule}" module is restricted for security.`
              );
            }

            if (id.startsWith('virtual:')) {
              return id;
            }
            // Resolve relative imports from virtual modules against the real file path
            if (importer && importer.startsWith('virtual:live-render:') && !isAbsolute(id)) {
              const realImporter = importer.replace('virtual:live-render:', '');
              return resolve(dirname(realImporter), id);
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
    return this.server.ssrLoadModule(filePath);
  }

  invalidateModule() {
    for (const [id, mod] of this.server.moduleGraph.idToModuleMap) {
      if (id.startsWith(this.rootPath) || id.startsWith('virtual:live-render')) {
        this.server.moduleGraph.invalidateModule(mod);
      }
    }
  }
}

import { type ViteDevServer, createServer } from 'vite';

export class ViteManager {
  server: ViteDevServer;
  private buffers: Map<string, string> = new Map();

  async init(rootPath: string) {
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
          resolveId(id) {
            if (id.startsWith('virtual:')) {
              return id;
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

  invalidateModule(filePath: string) {
    const cachedModule = this.server.moduleGraph.getModuleById(filePath);
    if (cachedModule) {
      this.server.moduleGraph.invalidateModule(cachedModule);
    }
  }
}

import { LocalSceneHost } from '../host/local-scene-host.ts';
import { FluidCadServer } from '../fluidcad-server/index.ts';

/**
 * A FluidCAD engine booted inside the calling process, with no port and no
 * page: a `LocalSceneHost` (Vite SSR over the workspace) driving a
 * `FluidCadServer`, initialized from the workspace's `init.js`. It runs this
 * process's own kernel — the CLI's engine, not the project's pinned one.
 *
 * One-shot commands render or scan through it: `fluidcad publish` renders
 * the entry once to capture its parameters, and `fluidcad pack` evaluates a
 * package's exports to snapshot and check them.
 *
 * Side-effect-free at import time. Call {@link close} when done: the Vite
 * dev server keeps the event loop alive, so a CLI process would not exit.
 * Import this (or use `fluidcad/server/api`), NOT `fluidcad/server`, which
 * boots the desktop binary.
 */
export class InProcessEngine {
  private constructor(
    readonly host: LocalSceneHost,
    readonly server: FluidCadServer,
  ) {}

  /**
   * Boot the engine over `workspacePath`. A workspace without `init.js`
   * still boots; {@link FluidCadServer.describeMissingEngine} then says why
   * nothing renders. A failed init closes what it started and rejects.
   */
  static async boot(workspacePath: string): Promise<InProcessEngine> {
    const host = new LocalSceneHost();
    const engine = new InProcessEngine(host, new FluidCadServer(host));
    try {
      await engine.server.init(workspacePath);
    } catch (err) {
      await engine.close();
      throw err;
    }
    return engine;
  }

  /** Boot, run `fn`, and close the engine whatever `fn` does. */
  static async run<T>(workspacePath: string, fn: (engine: InProcessEngine) => Promise<T>): Promise<T> {
    const engine = await InProcessEngine.boot(workspacePath);
    try {
      return await fn(engine);
    } finally {
      await engine.close();
    }
  }

  /** Stop the Vite dev server `LocalSceneHost.init()` started, so a one-shot process can exit. */
  async close(): Promise<void> {
    try {
      await this.host.server?.close();
    } catch {
      /* best-effort teardown */
    }
  }
}

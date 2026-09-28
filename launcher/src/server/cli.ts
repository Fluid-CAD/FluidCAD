import open from 'open';
import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';
import { findRunningLauncher, removeLauncherInstance, writeLauncherInstance } from './instance.ts';
import { packageVersion, startLauncherServer, type LauncherServer } from './launcher-server.ts';

/**
 * `npx fluidcad`: start the start server, or find the one already running,
 * and open the start screen in the browser. Everything the command does
 * besides that is here: the terminal's lines, the single-instance record, and
 * stopping every project's engine on Ctrl+C.
 */

export type LauncherCliOptions = {
  /** The `fluidcad` package the command runs from. */
  packageRoot: string;
  /** The first port to try. */
  port: number;
  /** Open the start screen in the default browser. */
  open: boolean;
};

/**
 * Behind a proxy, the engine downloads and the feed go through it. Node's
 * `fetch` ignores `HTTPS_PROXY` on its own; undici's dispatcher is the one it
 * uses underneath, so setting it here reaches every `fetch` in the process —
 * which is why loopback is always exempt: the launcher's calls to its own
 * engines must never leave the machine, and undici proxies everything that
 * `NO_PROXY` does not name.
 */
function followProxyEnvironment(): void {
  const { HTTPS_PROXY, https_proxy, HTTP_PROXY, http_proxy } = process.env;
  const noProxy = process.env.NO_PROXY ?? process.env.no_proxy ?? '';
  if (!(HTTPS_PROXY || https_proxy || HTTP_PROXY || http_proxy) || noProxy.trim() === '*') {
    return;
  }
  const exempt = [noProxy, 'localhost', '127.0.0.1', '::1', '[::1]'].filter((entry) => entry.trim() !== '');
  setGlobalDispatcher(new EnvHttpProxyAgent({ noProxy: exempt.join(',') }));
}

async function openBrowser(url: string): Promise<void> {
  try {
    const child = await open(url);
    // A one-shot handle; the browser outlives this process either way.
    child.unref?.();
  } catch {
    console.log('Could not open a browser; open the link above yourself.');
  }
}

/** Ctrl+C: previews, then every engine stopped, then out. A second Ctrl+C does not wait. */
function stopOnSignal(server: LauncherServer): void {
  let stopping = false;
  const stop = () => {
    if (stopping) {
      process.exit(1);
    }
    stopping = true;
    console.log('\nStopping FluidCAD and the projects it opened…');
    void server.close().finally(() => {
      removeLauncherInstance(process.pid);
      process.exit(0);
    });
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.on('exit', () => removeLauncherInstance(process.pid));
}

export async function runLauncher(options: LauncherCliOptions): Promise<void> {
  const running = await findRunningLauncher();
  if (running) {
    console.log(`FluidCAD is already running. Its start screen:\n\n  ${running.loginUrl}\n`);
    const version = packageVersion(options.packageRoot);
    if (running.version !== version) {
      console.log(
        `That is FluidCAD ${running.version}, and this is ${version}. To run ${version} instead, ` +
          'stop the other one with Ctrl+C in its terminal and run this again.',
      );
    }
    if (options.open) {
      await openBrowser(running.loginUrl);
    }
    return;
  }

  followProxyEnvironment();
  const server = await startLauncherServer({ packageRoot: options.packageRoot, port: options.port });
  writeLauncherInstance({
    schemaVersion: 1,
    pid: process.pid,
    port: server.port,
    version: server.version,
    loginUrl: server.loginUrl,
    startedAt: new Date().toISOString(),
  });
  stopOnSignal(server);

  if (server.port !== options.port) {
    console.log(`Port ${options.port} is in use, so FluidCAD took ${server.port}.`);
  }
  console.log(`FluidCAD ${server.version}. The start screen:\n\n  ${server.loginUrl}\n`);
  console.log('Projects open in their own tabs. Press Ctrl+C to stop FluidCAD and every project it opened.');
  if (options.open) {
    await openBrowser(server.loginUrl);
  }
}

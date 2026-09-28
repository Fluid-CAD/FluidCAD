import { guardedHost, type StartScreenBridge, type StartScreenHost } from './host';

export type HostEnvironment = {
  /** `window.fluidcadShell.start`, when the desktop app exposed it. */
  bridge: StartScreenBridge | undefined;
  /** The page's query string; `?host=fixture` asks for the fixture host. */
  search: string;
  /**
   * Loads the fixture host. Null in a production build, where `main.ts` never
   * references the fixture module, so it is not bundled at all.
   */
  loadFixture: ((params: URLSearchParams) => Promise<StartScreenHost>) | null;
  /** The start server `npx fluidcad` runs, when this page came from one over http; null otherwise. */
  loadHttp: (() => StartScreenHost) | null;
};

/**
 * Which host the start screen talks to: the desktop app whenever its bridge
 * is there, the fixture in a dev build that asks for it, `npx fluidcad`'s
 * start server when the page was served over http, and otherwise none — the
 * page then says how to start FluidCAD.
 */
export async function chooseStartHost(env: HostEnvironment): Promise<StartScreenHost | null> {
  if (env.bridge) {
    return guardedHost(env.bridge);
  }
  const params = new URLSearchParams(env.search);
  if (env.loadFixture && params.get('host') === 'fixture') {
    return env.loadFixture(params);
  }
  return env.loadHttp ? env.loadHttp() : null;
}

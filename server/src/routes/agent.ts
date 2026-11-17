// `api/agent/...`: the in-app agent's routes (docs/agent-chat-plan.md §6.1, §7).
//
// The runtime lives in its own package (`agent/`) and is loaded on the first
// request with a dynamic `import()` of a file URL, the way `fluidcad mcp`
// loads the MCP server. An engine built without it answers 404, and the page
// hides the Agent button.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import type { AgentHostDeps, AgentModule } from '../agent-host.ts';

/** `agent/dist/index.js`, beside `server/dist/` in the source tree and in the package. */
export const AGENT_ENTRY = path.resolve(import.meta.dirname, '../../../agent/dist/index.js');

/**
 * Refuses a request a browser made from another site (§7.4). Browsers send
 * `Sec-Fetch-Site` on every request and page script cannot forge it; the
 * CLIs and other non-browser clients send none, and the launcher's proxy
 * passes it through unchanged. An Origin check would not survive that proxy,
 * which rewrites `host` and keeps the page's `origin`.
 */
export const requireSameOriginFetch: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
  const site = req.get('Sec-Fetch-Site');
  if (site !== undefined && site !== 'same-origin') {
    res.status(403).json({ error: 'Cross-site requests to the agent API are refused.' });
    return;
  }
  next();
};

export type AgentRoutesOptions = {
  /** The runtime's entry file; tests point it elsewhere. */
  entry?: string;
};

export function createAgentRoutes(deps: AgentHostDeps, options: AgentRoutesOptions = {}): Router {
  const entry = options.entry ?? AGENT_ENTRY;
  const router = Router();
  let loading: Promise<Router | null> | null = null;

  const load = (): Promise<Router | null> => {
    loading ??= (async () => {
      if (!fs.existsSync(entry)) {
        return null;
      }
      const mod = (await import(pathToFileURL(entry).href)) as Partial<AgentModule>;
      if (typeof mod.createAgentRouter !== 'function') {
        throw new Error(`${entry} does not export createAgentRouter.`);
      }
      return mod.createAgentRouter(deps);
    })().catch((e) => {
      console.error('[agent] the agent runtime failed to load:', e);
      // Try again on the next request rather than caching a failure.
      loading = null;
      throw e;
    });
    return loading;
  };

  router.use('/agent', requireSameOriginFetch);
  router.use('/agent', async (req, res, next) => {
    let agentRouter: Router | null;
    try {
      agentRouter = await load();
    } catch (e) {
      res.status(503).json({ error: `The agent runtime failed to load: ${e instanceof Error ? e.message : String(e)}` });
      return;
    }
    if (!agentRouter) {
      res.status(404).json({ error: 'This engine has no agent runtime.' });
      return;
    }
    agentRouter(req, res, next);
  });
  return router;
}

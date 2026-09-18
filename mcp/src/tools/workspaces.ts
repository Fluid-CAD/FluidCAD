// Workspace enumeration tool — the agent's entry point for discovery.
//
// Returns every running FluidCAD workspace on this machine, with a quick
// health probe so dead-but-not-yet-pruned entries surface as `reachable: false`
// instead of being silently dropped.
//
// A server in the middle of a render cannot answer the probe — the geometry
// kernel holds its event loop — but its process is alive and its port still
// accepts connections. That is `reachable: true, busy: true`: requests sent
// to it queue behind the render instead of failing.

import { connect } from 'node:net';
import { listLiveInstances } from '../discovery.ts';
import { FluidCadClient } from '../client.ts';
import { ok, type ToolResult } from '../types.ts';

export type WorkspaceInfo = {
  workspacePath: string;
  port: number;
  pid: number;
  version: string;
  startedAt: string;
  reachable: boolean;
  /** Alive but not answering — mid-render. Requests queue until it finishes. */
  busy: boolean;
};

const PORT_PROBE_TIMEOUT_MS = 300;

/** Whether something is listening on the port — true even while its event loop is blocked. */
function isPortBound(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    const finish = (bound: boolean) => {
      socket.destroy();
      resolve(bound);
    };
    socket.setTimeout(PORT_PROBE_TIMEOUT_MS, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

export type ListWorkspacesOutput = {
  workspaces: WorkspaceInfo[];
};

export async function listWorkspaces(): Promise<ToolResult<ListWorkspacesOutput>> {
  const entries = listLiveInstances();

  const probes = await Promise.all(
    entries.map(async (entry) => {
      const client = new FluidCadClient(entry);
      try {
        const health = await client.health();
        if (health !== null) {
          return { entry, reachable: true, busy: false };
        }
        const busy = await isPortBound(entry.port);
        return { entry, reachable: busy, busy };
      } finally {
        // We don't keep clients around past the probe — each tool invocation
        // re-creates them when needed. Pools are cheap; lingering connections
        // are not.
        await client.close().catch(() => {});
      }
    }),
  );

  const workspaces: WorkspaceInfo[] = probes.map(({ entry, reachable, busy }) => ({
    workspacePath: entry.workspacePath,
    port: entry.port,
    pid: entry.pid,
    version: entry.version,
    startedAt: entry.startedAt,
    reachable,
    busy,
  }));

  return ok({ workspaces });
}

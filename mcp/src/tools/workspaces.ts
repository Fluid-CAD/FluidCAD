// Workspace enumeration tool — the agent's entry point for discovery.
//
// Returns every running FluidCAD workspace on this machine, with a quick
// health probe so dead-but-not-yet-pruned entries surface as `reachable: false`
// instead of being silently dropped.

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
};

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
        return { entry, reachable: health !== null };
      } finally {
        // We don't keep clients around past the probe — each tool invocation
        // re-creates them when needed. Pools are cheap; lingering connections
        // are not.
        await client.close().catch(() => {});
      }
    }),
  );

  const workspaces: WorkspaceInfo[] = probes.map(({ entry, reachable }) => ({
    workspacePath: entry.workspacePath,
    port: entry.port,
    pid: entry.pid,
    version: entry.version,
    startedAt: entry.startedAt,
    reachable,
  }));

  return ok({ workspaces });
}

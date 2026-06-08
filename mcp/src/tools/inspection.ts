// Inspection tools — read-only views of a running FluidCAD workspace.
//
// Each tool maps to a single HTTP call against the FluidCAD server. The
// workspace resolution rule is consistent across all of them: an explicit
// `workspace` wins; with one running instance the singleton is used; with
// multiple, the agent must disambiguate.

import { findByWorkspace, listLiveInstances } from '../discovery.ts';
import { FluidCadClient, HttpError } from '../client.ts';
import { err, ok, type ToolResult } from '../types.ts';
import type { RegistryEntry } from '../types.ts';

export type WorkspaceArg = { workspace?: string };

export type ResolvedClient = {
  client: FluidCadClient;
  entry: RegistryEntry;
};

/**
 * Resolve a workspace argument to a `FluidCadClient`. Returns an error
 * variant when the argument is ambiguous or cannot be matched. Callers own
 * `client.close()` (typically inside a finally).
 */
export function resolveClient(
  input: WorkspaceArg,
): ToolResult<ResolvedClient> {
  if (input?.workspace) {
    const entry = findByWorkspace(input.workspace);
    if (!entry) {
      return err(
        'workspace-not-found',
        `No running FluidCAD workspace at "${input.workspace}". Call list_workspaces to see what's available.`,
      );
    }
    return ok({ client: new FluidCadClient(entry), entry });
  }

  const instances = listLiveInstances();
  if (instances.length === 0) {
    return err('no-server', 'No running FluidCAD workspaces. Start one with `fluidcad serve`.');
  }
  if (instances.length > 1) {
    return err(
      'no-workspace',
      `Multiple FluidCAD workspaces are running (${instances.length}). Pass \`workspace\` to disambiguate.`,
      { workspaces: instances.map((e) => e.workspacePath) },
    );
  }
  return ok({ client: new FluidCadClient(instances[0]), entry: instances[0] });
}

async function callWithClient<T>(
  input: WorkspaceArg,
  fn: (client: FluidCadClient) => Promise<T>,
): Promise<ToolResult<T>> {
  const resolved = resolveClient(input);
  if (resolved.ok === false) {
    return resolved as ToolResult<T>;
  }
  const { client } = resolved.data;
  try {
    const data = await fn(client);
    return ok(data);
  } catch (e: any) {
    if (e instanceof HttpError) {
      return err('http-error', `HTTP ${e.statusCode}: ${e.body.slice(0, 200)}`, {
        statusCode: e.statusCode,
      });
    }
    return err('internal', e?.message ?? String(e));
  } finally {
    await client.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export type GetSceneSummaryInput = WorkspaceArg;
export async function getSceneSummary(input: GetSceneSummaryInput) {
  return callWithClient(input, (client) => client.getJson<unknown>('/api/scene/summary'));
}

export type ListShapesInput = WorkspaceArg;
export async function listShapes(input: ListShapesInput) {
  return callWithClient(input, (client) => client.getJson<unknown>('/api/scene/shapes'));
}

export type GetCompileErrorInput = WorkspaceArg;
export async function getCompileError(input: GetCompileErrorInput) {
  return callWithClient(input, (client) => client.getJson<unknown>('/api/scene/compile-error'));
}

export type GetShapePropertiesInput = WorkspaceArg & { shapeId: string };
export async function getShapeProperties(input: GetShapePropertiesInput) {
  if (!input?.shapeId || typeof input.shapeId !== 'string') {
    return err('invalid-input', '`shapeId` is required and must be a non-empty string.');
  }
  const shapeId = input.shapeId;
  return callWithClient(input, (client) =>
    client.getJson<unknown>(`/api/shape-properties?shapeId=${encodeURIComponent(shapeId)}`),
  );
}

export type GetFacePropertiesInput = WorkspaceArg & {
  shapeId: string;
  faceIndex: number;
};
export async function getFaceProperties(input: GetFacePropertiesInput) {
  if (!input?.shapeId || typeof input.shapeId !== 'string') {
    return err('invalid-input', '`shapeId` is required and must be a non-empty string.');
  }
  if (
    typeof input.faceIndex !== 'number' ||
    !Number.isInteger(input.faceIndex) ||
    input.faceIndex < 0
  ) {
    return err('invalid-input', '`faceIndex` is required and must be a non-negative integer.');
  }
  const { shapeId, faceIndex } = input;
  return callWithClient(input, (client) =>
    client.getJson<unknown>(
      `/api/face-properties?shapeId=${encodeURIComponent(shapeId)}&faceIndex=${faceIndex}`,
    ),
  );
}

export type GetEdgePropertiesInput = WorkspaceArg & {
  shapeId: string;
  edgeIndex: number;
};
export async function getEdgeProperties(input: GetEdgePropertiesInput) {
  if (!input?.shapeId || typeof input.shapeId !== 'string') {
    return err('invalid-input', '`shapeId` is required and must be a non-empty string.');
  }
  if (
    typeof input.edgeIndex !== 'number' ||
    !Number.isInteger(input.edgeIndex) ||
    input.edgeIndex < 0
  ) {
    return err('invalid-input', '`edgeIndex` is required and must be a non-negative integer.');
  }
  const { shapeId, edgeIndex } = input;
  return callWithClient(input, (client) =>
    client.getJson<unknown>(
      `/api/edge-properties?shapeId=${encodeURIComponent(shapeId)}&edgeIndex=${edgeIndex}`,
    ),
  );
}

export type HitTestInput = WorkspaceArg & {
  shapeId: string;
  rayOrigin: [number, number, number];
  rayDir: [number, number, number];
  edgeThreshold?: number;
};
export async function hitTest(input: HitTestInput) {
  if (!input?.shapeId || typeof input.shapeId !== 'string') {
    return err('invalid-input', '`shapeId` is required and must be a non-empty string.');
  }
  if (!isVec3(input?.rayOrigin)) {
    return err('invalid-input', '`rayOrigin` must be a 3-element array of finite numbers.');
  }
  if (!isVec3(input?.rayDir)) {
    return err('invalid-input', '`rayDir` must be a 3-element array of finite numbers.');
  }
  const edgeThreshold = input.edgeThreshold;
  if (
    edgeThreshold !== undefined &&
    (typeof edgeThreshold !== 'number' || !Number.isFinite(edgeThreshold) || edgeThreshold < 0)
  ) {
    return err('invalid-input', '`edgeThreshold` must be a non-negative finite number when provided.');
  }
  const body = {
    shapeId: input.shapeId,
    rayOrigin: input.rayOrigin,
    rayDir: input.rayDir,
    edgeThreshold: edgeThreshold ?? 0,
  };
  return callWithClient(input, (client) => client.postJson<unknown>('/api/hit-test', body));
}

function isVec3(value: unknown): value is [number, number, number] {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every((n) => typeof n === 'number' && Number.isFinite(n))
  );
}

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
import { MeasureImage, type MeasureImageInput } from './measure-image.ts';
import { ScreenshotRequest, type ImageBlock } from './screenshot-request.ts';
import { ScreenshotViews } from './screenshot-views.ts';

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

/** Where a filter expression is evaluated — a scene object, a part, or an assembly instance. */
export type SelectionScopeInput = { sceneObjectId: string } | { part: string } | { instanceId: string };

/**
 * Input checks shared by `resolve_selection` and the filter form of
 * `measure` entities: the server validates again, but a malformed scope is
 * cheaper to refuse here with the exact field named.
 */
class SelectionInputs {
  static expressionError(expression: unknown, label = '`expression`'): string | null {
    if (typeof expression !== 'string' || expression.trim().length === 0) {
      return `${label} must be a non-empty string of FluidCAD filter syntax, e.g. face().onPlane("xy", 10).`;
    }
    return null;
  }

  static scopeError(scope: unknown, label = '`scope`'): string | null {
    if (scope === undefined) {
      return null;
    }
    if (typeof scope !== 'object' || scope === null || Array.isArray(scope)) {
      return `${label} must be one of { sceneObjectId }, { part } or { instanceId }.`;
    }
    const keys = Object.keys(scope);
    const given = keys.filter((k) => k === 'sceneObjectId' || k === 'part' || k === 'instanceId');
    if (given.length !== 1 || keys.length !== 1) {
      return `${label} needs exactly one of sceneObjectId, part or instanceId.`;
    }
    const value = (scope as Record<string, unknown>)[given[0]];
    if (typeof value !== 'string' || value.length === 0) {
      return `${label}.${given[0]} must be a non-empty string.`;
    }
    return null;
  }
}

/** A face/edge ref the way `measure` and `hit_test` address entities. */
export type SelectionPickInput = { shapeId: string; kind: 'face' | 'edge'; index: number };

export type ResolveSelectionInput = WorkspaceArg & {
  expression?: string;
  picks?: SelectionPickInput[];
  scope?: SelectionScopeInput;
  before?: number;
};

/**
 * Input checks for the pick and boundary forms of `resolve_selection`: the
 * server validates again, but a malformed ref is cheaper to refuse here
 * with the exact field named.
 */
class ResolveSelectionInputs {
  static readonly MAX_PICKS = 500;

  static error(input: ResolveSelectionInput | undefined): string | null {
    const hasExpression = input?.expression !== undefined;
    const hasPicks = input?.picks !== undefined;
    if (hasExpression === hasPicks) {
      return 'Pass exactly one of `expression` (filter syntax) or `picks` ({ shapeId, kind, index } refs).';
    }
    if (hasExpression) {
      const expressionError = SelectionInputs.expressionError(input!.expression);
      if (expressionError) {
        return expressionError;
      }
    } else {
      const picks = input!.picks;
      if (!Array.isArray(picks) || picks.length === 0 || picks.length > ResolveSelectionInputs.MAX_PICKS) {
        return `\`picks\` must be an array of 1-${ResolveSelectionInputs.MAX_PICKS} { shapeId, kind, index } refs.`;
      }
      for (let i = 0; i < picks.length; i++) {
        const pick = picks[i];
        const validKind = pick?.kind === 'face' || pick?.kind === 'edge';
        const validIndex = Number.isInteger(pick?.index) && pick.index >= 0;
        if (!pick || typeof pick.shapeId !== 'string' || pick.shapeId.length === 0 || !validKind || !validIndex) {
          return `\`picks[${i}]\` needs a shapeId, a kind (face | edge) and a non-negative index.`;
        }
      }
    }
    const scopeError = SelectionInputs.scopeError(input?.scope);
    if (scopeError) {
      return scopeError;
    }
    if (input?.before !== undefined && (!Number.isInteger(input.before) || input.before < 1)) {
      return '`before` must be a positive integer: the scene-object index (from get_scene_summary) of the statement the selection is written before.';
    }
    return null;
  }
}

export async function resolveSelection(input: ResolveSelectionInput) {
  const problem = ResolveSelectionInputs.error(input);
  if (problem) {
    return err('invalid-input', problem);
  }
  const body = {
    ...(input.expression !== undefined ? { expression: input.expression } : { picks: input.picks }),
    ...(input.scope ? { scope: input.scope } : {}),
    ...(input.before !== undefined ? { before: input.before } : {}),
  };
  return callWithClient(input, (client) => client.postJson<unknown>('/api/resolve-selection', body));
}

export type ValidateInput = WorkspaceArg & { shapeIds?: string[]; instanceId?: string };

/**
 * Input checks for `validate`: the server validates again, but a malformed
 * list is cheaper to refuse here with the exact field named.
 */
class ValidateInputs {
  static readonly MAX_SHAPE_IDS = 500;

  static error(input: ValidateInput | undefined): string | null {
    const shapeIds = input?.shapeIds;
    if (shapeIds !== undefined) {
      if (!Array.isArray(shapeIds) || shapeIds.length === 0 || shapeIds.length > ValidateInputs.MAX_SHAPE_IDS) {
        return `\`shapeIds\` must be an array of 1-${ValidateInputs.MAX_SHAPE_IDS} shape ids when given; omit it to check every solid the scene renders.`;
      }
      if (!shapeIds.every((id) => typeof id === 'string' && id.length > 0)) {
        return '`shapeIds` entries must be non-empty strings (ids from list_shapes or get_scene_summary).';
      }
    }
    const instanceId = input?.instanceId;
    if (instanceId !== undefined && (typeof instanceId !== 'string' || instanceId.length === 0)) {
      return '`instanceId` must be a non-empty string when given (ids from get_scene_summary in an assembly file).';
    }
    return null;
  }
}

export async function validate(input: ValidateInput) {
  const error = ValidateInputs.error(input);
  if (error) {
    return err('invalid-input', error);
  }
  const body = {
    ...(input?.shapeIds ? { shapeIds: input.shapeIds } : {}),
    ...(input?.instanceId !== undefined ? { instanceId: input.instanceId } : {}),
  };
  return callWithClient(input ?? {}, (client) => client.postJson<unknown>('/api/validate', body));
}

export type InterferencePoseInput = {
  instanceId: string;
  position: { x: number; y: number; z: number };
  quaternion: { x: number; y: number; z: number; w: number };
};
export type InterfereInput = WorkspaceArg & {
  instanceIds?: string[];
  shapeIds?: string[];
  tolerance?: number;
  poses?: InterferencePoseInput[];
};

/**
 * Input checks for `interfere`: the server validates again, but a malformed
 * list or threshold is cheaper to refuse here with the exact field named.
 */
class InterfereInputs {
  static readonly MAX_IDS = 500;

  static error(input: InterfereInput | undefined): string | null {
    const idsError = InterfereInputs.idListError('shapeIds', input?.shapeIds, 'ids from list_shapes or get_scene_summary; omit it to check every solid the scene renders')
      ?? InterfereInputs.idListError('instanceIds', input?.instanceIds, 'ids from get_scene_summary in an assembly file; omit it to check every instance');
    if (idsError) {
      return idsError;
    }
    const tolerance = input?.tolerance;
    if (tolerance !== undefined && (typeof tolerance !== 'number' || !Number.isFinite(tolerance) || tolerance < 0)) {
      return '`tolerance` must be a finite number >= 0: the smallest shared volume, in the document unit cubed, that counts as a clash.';
    }
    const poses = input?.poses;
    if (poses !== undefined) {
      if (!Array.isArray(poses) || poses.length === 0) {
        return '`poses` must be a non-empty array of { instanceId, position, quaternion } when given.';
      }
      for (const pose of poses) {
        if (typeof pose?.instanceId !== 'string' || pose.instanceId.length === 0) {
          return '`poses` entries need a non-empty `instanceId` (ids from get_scene_summary).';
        }
        if (!InterfereInputs.isPose(pose)) {
          return `\`poses\` entry for "${pose.instanceId}" needs a finite position {x,y,z} and a non-zero quaternion {x,y,z,w}.`;
        }
      }
    }
    return null;
  }

  private static idListError(field: string, value: unknown, hint: string): string | null {
    if (value === undefined) {
      return null;
    }
    if (!Array.isArray(value) || value.length === 0 || value.length > InterfereInputs.MAX_IDS) {
      return `\`${field}\` must be an array of 1-${InterfereInputs.MAX_IDS} ids when given (${hint}).`;
    }
    if (!value.every((id) => typeof id === 'string' && id.length > 0)) {
      return `\`${field}\` entries must be non-empty strings (${hint}).`;
    }
    return null;
  }

  private static isPose(pose: InterferencePoseInput): boolean {
    const finite = (v: unknown, keys: string[]) =>
      typeof v === 'object' && v !== null && keys.every((k) => Number.isFinite((v as Record<string, unknown>)[k]));
    if (!finite(pose.position, ['x', 'y', 'z']) || !finite(pose.quaternion, ['x', 'y', 'z', 'w'])) {
      return false;
    }
    const q = pose.quaternion;
    return Math.hypot(q.x, q.y, q.z, q.w) > 0;
  }
}

export async function interfere(input: InterfereInput) {
  const error = InterfereInputs.error(input);
  if (error) {
    return err('invalid-input', error);
  }
  const body = {
    ...(input?.instanceIds ? { instanceIds: input.instanceIds } : {}),
    ...(input?.shapeIds ? { shapeIds: input.shapeIds } : {}),
    ...(input?.tolerance !== undefined ? { tolerance: input.tolerance } : {}),
    ...(input?.poses ? { poses: input.poses } : {}),
  };
  return callWithClient(input ?? {}, (client) => client.postJson<unknown>('/api/interfere', body));
}

export type MeasureIndexEntityInput = { shapeId: string; kind: 'face' | 'edge'; index: number; instanceId?: string };
export type MeasureFilterEntityInput = { expression: string; scope?: SelectionScopeInput };
export type MeasureEntityInput = MeasureIndexEntityInput | MeasureFilterEntityInput;

/**
 * Input checks for an entity list in the `measure` union — index refs or
 * filter expressions — shared by `measure` and the screenshot tools'
 * `highlight`.
 */
export class MeasureEntityInputs {

  static error(entities: unknown, bounds: { min: number; max: number; label: string }): string | null {
    const { min, max, label } = bounds;
    if (!Array.isArray(entities) || entities.length < min || entities.length > max) {
      return `\`${label}\` must be an array of ${min}-${max} face/edge references or filter expressions.`;
    }
    for (let i = 0; i < entities.length; i++) {
      const entity = entities[i] as Partial<MeasureIndexEntityInput & MeasureFilterEntityInput> | null;
      if (entity && typeof entity === 'object' && 'expression' in entity) {
        const problem = SelectionInputs.expressionError(entity.expression, `\`${label}[${i}].expression\``)
          ?? SelectionInputs.scopeError(entity.scope, `\`${label}[${i}].scope\``);
        if (problem) {
          return problem;
        }
        continue;
      }
      const validKind = entity?.kind === 'face' || entity?.kind === 'edge';
      const validIndex = typeof entity?.index === 'number' && Number.isInteger(entity.index) && entity.index >= 0;
      if (!entity || typeof entity.shapeId !== 'string' || !entity.shapeId || !validKind || !validIndex) {
        return `Each \`${label}\` entry needs a \`shapeId\`, a \`kind\` (face|edge) and a non-negative \`index\`, or an \`expression\` (with optional \`scope\`).`;
      }
      if (entity.instanceId !== undefined && (typeof entity.instanceId !== 'string' || !entity.instanceId)) {
        return `\`${label}[${i}].instanceId\` must be a non-empty string when given.`;
      }
    }
    return null;
  }
}

export type MeasureInput = WorkspaceArg & { entities: MeasureEntityInput[]; image?: MeasureImageInput };

/**
 * Measure, and — when `image` is given — also capture the measured entities
 * highlighted with the primary value drawn between its realizing points.
 * The result then carries `image` beside the measurement, which `toMcp`
 * renders as a text block followed by an image block.
 */
export async function measure(input: MeasureInput) {
  const entities = input?.entities;
  const problem = MeasureEntityInputs.error(entities, { min: 1, max: 8, label: 'entities' });
  if (problem) {
    return err('invalid-input', problem);
  }
  const image = MeasureImage.validate(input?.image, (view) => ScreenshotViews.validate(view));
  if (image.ok === false) {
    return image as ToolResult<unknown>;
  }
  const resolved = resolveClient(input);
  if (resolved.ok === false) {
    return resolved as ToolResult<unknown>;
  }
  const { client } = resolved.data;
  try {
    const measured = await client.postJson<Record<string, any>>('/api/measure', { entities });
    if (input.image === undefined) {
      return ok<unknown>(measured);
    }
    const shot = await ScreenshotRequest.post(client, MeasureImage.screenshotBody(measured, image.data));
    if (shot.ok === false) {
      return err(shot.code, `measured, but the image failed: ${shot.message}`, { ...(shot.details as object ?? {}), measured });
    }
    const withImage: Record<string, unknown> = { ...measured, image: shot.data.image satisfies ImageBlock };
    return ok<unknown>(withImage);
  } catch (e: any) {
    return ScreenshotRequest.wrapError<unknown>(e);
  } finally {
    await client.close().catch(() => {});
  }
}

function isVec3(value: unknown): value is [number, number, number] {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every((n) => typeof n === 'number' && Number.isFinite(n))
  );
}

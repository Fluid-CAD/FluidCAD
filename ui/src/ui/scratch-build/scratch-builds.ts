import type { LengthUnit } from '../../units/units';
import type {
  CompileError,
  SceneObjectRender,
  SerializedAssemblyConnector,
  SerializedAssemblyInstance,
  SerializedAssemblyMate,
  SourceLocation,
} from '../../types';
import type { PartThumbnailRenderer } from '../insert-part/part-thumbnails';

/** What `POST api/scratch-build` builds — mirrored from the engine's `ScratchBuildRequest`. */
export type ScratchBuildRequest = {
  /** The model file the build is of, absolute or workspace-relative. */
  file: string;
  /** The whole candidate text of `file`; absent, the file as a render would read it now. */
  source?: string;
  /** Parameter values for this build only, by `param()` label. */
  params?: Record<string, string | number | boolean | (string | number)[]>;
};

/** What a scratch build that evaluated produced — the engine's `ScratchBuildFacts`. */
export type ScratchBuildFacts = {
  /** Names the build's meshes on the engine while it keeps them ({@link ScratchBuilds.meshes}). */
  id: string;
  file: string;
  sceneKind: 'part' | 'assembly';
  unit: LengthUnit;
  durationMs: number;
  builtFrom: 'source' | 'buffer' | 'disk';
  configuration: string;
  sessionOverrides: number;
  unusedParams: string[];
  solidCount: number;
  bounds: { min: [number, number, number]; max: [number, number, number] } | null;
  /** The solids' total, in `unit` cubed. */
  volume: number | null;
  validation: {
    ok: boolean;
    checked: number;
    findings: { kind: string; shapeId: string; sceneObjectId: string; part: string | null; message: string }[];
    skipped: number;
  } | null;
  instanceCount?: number;
  breakpointHit?: true;
};

/** One feature that failed to build; `index` numbers the build's rows, `sourceLocation` is 1-based. */
export type ScratchBuildObjectError = {
  index: number;
  id: string;
  name: string;
  uniqueKind: string;
  message: string;
  sourceLocation?: SourceLocation;
};

/** How a scratch build went: the states a render reports. */
export type ScratchBuildOutcome =
  | ({ state: 'rendered' } & ScratchBuildFacts)
  | ({ state: 'build-error'; objectErrors: ScratchBuildObjectError[] } & ScratchBuildFacts)
  | { state: 'compile-error'; file: string; durationMs: number; compileError: CompileError };

/** A scratch build's rendered rows — the wire shape of a scene, every mesh whole. */
export type ScratchBuildMeshes = {
  id: string;
  file: string;
  sceneKind: 'part' | 'assembly';
  unit: LengthUnit;
  objects: SceneObjectRender[];
  /** An assembly's instances: `objects` are its part templates, drawn once per instance. */
  assembly?: {
    instances: SerializedAssemblyInstance[];
    mates: SerializedAssemblyMate[];
    connectors: SerializedAssemblyConnector[];
  };
};

/**
 * The page's side of scratch builds: a candidate version of a model file
 * built on the engine without writing it and without touching the scene on
 * screen (`FluidCadServer.scratchBuild`), and the meshes of one to draw a
 * tile from.
 *
 * The engine keeps a build's meshes for a while only (its newest dozen, at
 * most half an hour): fetch them when the tile first shows and keep the
 * picture {@link thumbnail} draws, not the id.
 */
export class ScratchBuilds {

  /**
   * Build a candidate. The answer is held for as long as the build takes,
   * behind any render in progress; a candidate that fails is an outcome
   * (`build-error`, `compile-error`), not a refusal. A refusal — a file
   * outside the workspace or that is no model, no engine — is its `error`.
   */
  static async build(request: ScratchBuildRequest, signal?: AbortSignal): Promise<ScratchBuildOutcome | { error: string }> {
    try {
      const res = await fetch('api/scratch-build', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
        signal,
      });
      const body = await res.json().catch((): null => null);
      if (!res.ok || body === null) {
        return { error: typeof body?.error === 'string' ? body.error : `The build could not run (HTTP ${res.status}).` };
      }
      return body as ScratchBuildOutcome;
    } catch (err: any) {
      return { error: err?.name === 'AbortError' ? 'Cancelled.' : err?.message ?? String(err) };
    }
  }

  /** The meshes of build `id`, or null once the engine no longer keeps them (build it again). */
  static async meshes(id: string, signal?: AbortSignal): Promise<ScratchBuildMeshes | null> {
    try {
      const res = await fetch(`api/scratch-build/${encodeURIComponent(id)}/meshes`, { signal });
      return res.ok ? (await res.json()) as ScratchBuildMeshes : null;
    } catch {
      return null;
    }
  }

  /**
   * A build's picture as a PNG data URL, drawn by the Insert dialog's
   * thumbnail renderer: an assembly posed and solved as its sub-assembly
   * tiles are, any other model as the whole scene. Null when it shows
   * nothing (no solid built).
   */
  static thumbnail(renderer: PartThumbnailRenderer, meshes: ScratchBuildMeshes): string | null {
    if (meshes.assembly) {
      return renderer.renderAssembly(meshes.objects, meshes.assembly.instances, meshes.assembly.mates, meshes.assembly.connectors);
    }
    return renderer.renderScene(meshes.objects);
  }

  /**
   * The pictures of several builds drawn from one camera, framed on what
   * they draw together (`PartThumbnailRenderer.renderTogether`): two
   * versions of a model at the same place and scale. One PNG data URL per
   * build, null for one that shows nothing.
   */
  static thumbnails(renderer: PartThumbnailRenderer, builds: ScratchBuildMeshes[]): (string | null)[] {
    return renderer.renderTogether(builds.map(meshes => ({
      objects: meshes.objects,
      ...(meshes.assembly ? { assembly: meshes.assembly } : {}),
    })));
  }
}

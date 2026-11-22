// Scratch builds: a candidate version of a model file built to see what it would produce, with nothing live touched.

import { randomUUID } from 'crypto';
import type { FluidScriptKind } from '../file-kind.ts';
import type { LengthUnit } from '../project-config.ts';
import type { CompileError } from '../ws-protocol.ts';
import type { SceneValidationReport } from '../../../lib/dist/index.js';
import { SceneMeshes, type MeshPayload } from '../scene-meshes/scene-meshes.ts';
import type { SerializedAssembly } from './assembly-types.ts';
import type { ObjectBuildError } from './render-types.ts';

/** What `FluidCadServer.scratchBuild` builds. */
export type ScratchBuildRequest = {
  /** The model file the build is of (`.fluid.js`, `.part.js`, `.assembly.js`), absolute. It need not exist when `source` is given. */
  file: string;
  /**
   * The whole candidate text of `file`, evaluated in its place and never
   * written. Absent: the file as a render would read it now — the editor's
   * buffer when one is held, else its bytes on disk.
   */
  source?: string;
  /**
   * Parameter values for this build only, by label (`{ Width: 80 }`: that
   * label in every part declaring it) or by `ParamKey.id`
   * (`'["Plate","Width"]'`). Each replaces the session's override of the
   * parameter it names; nothing of them is kept.
   */
  params?: Record<string, unknown>;
};

/** Axis-aligned bounds in the build's unit. */
export type ScratchBuildBounds = { min: [number, number, number]; max: [number, number, number] };

/** The soundness verdict of a scratch build's solids — `validate`'s, cut down to what a verdict needs. */
export type ScratchBuildValidation = {
  /** True only when no solid has a finding. */
  ok: boolean;
  /** Shapes examined. */
  checked: number;
  findings: { kind: string; shapeId: string; sceneObjectId: string; part: string | null; message: string }[];
  /** Shapes that could not be examined. */
  skipped: number;
};

/** What a scratch build that evaluated produced. */
export type ScratchBuildFacts = {
  /**
   * Names the build's meshes in the {@link ScratchBuildStore} — what
   * `GET /api/scratch-build/:id/meshes` serves while they are kept.
   */
  id: string;
  /** The file built, absolute and normalized. */
  file: string;
  sceneKind: FluidScriptKind;
  /** The unit every length below is in: the candidate's own `unit()`, else the project's. */
  unit: LengthUnit;
  durationMs: number;
  /** What was evaluated as `file`: the request's `source`, the editor's buffer, or the bytes on disk. */
  builtFrom: 'source' | 'buffer' | 'disk';
  /** The `configurations()` row the build ran with — the one the file's session shows; `'Default'` is the literals. */
  configuration: string;
  /** How many of the session's Parameters-panel overrides the build ran with, beside the request's `params`. */
  sessionOverrides: number;
  /** The request's `params` no `param()` of the build declared, so they changed nothing. */
  unusedParams: string[];
  /** How many solids the build renders — in an assembly, counted once per instance showing them. */
  solidCount: number;
  /**
   * The exact bounds of the rendered solids (the engine's
   * `getRenderedBounds`) — in an assembly, over every instance where its
   * mates put it. Null when the build renders no solid, or on an engine
   * that cannot say.
   */
  bounds: ScratchBuildBounds | null;
  /**
   * The rendered solids' total volume, in `unit` cubed — in an assembly,
   * each part's counted once per instance. Null when the build renders no
   * solid, or on an engine without geometry validation.
   */
  volume: number | null;
  /** Null on an engine without geometry validation, or when it refused. */
  validation: ScratchBuildValidation | null;
  /** Assemblies: how many instances the build placed. */
  instanceCount?: number;
  /** The build stopped at a `breakpoint()`: what ran before it is what was built. */
  breakpointHit?: true;
};

/**
 * How a scratch build went, in the states a render reports
 * (`routes/render.ts`): `rendered`; `build-error` when the file ran and a
 * feature failed to build (its geometry is missing from the facts);
 * `compile-error` when it did not evaluate, with no facts and no meshes.
 */
export type ScratchBuildOutcome =
  | ({ state: 'rendered' } & ScratchBuildFacts)
  | ({ state: 'build-error'; objectErrors: ObjectBuildError[] } & ScratchBuildFacts)
  | { state: 'compile-error'; file: string; durationMs: number; compileError: CompileError };

/**
 * A scratch build's rendered rows, as `GET /api/scratch-build/:id/meshes`
 * answers them: the wire shape of a `scene-rendered` result with every mesh
 * whole (no mesh references), so the page builds it with the ordinary mesh
 * factory. An assembly's rows are its part templates, drawn once per
 * instance of `assembly` (the same records the assembly view poses).
 */
export type ScratchBuildMeshes = {
  id: string;
  file: string;
  sceneKind: FluidScriptKind;
  unit: LengthUnit;
  objects: any[];
  assembly?: Pick<SerializedAssembly, 'instances' | 'mates' | 'connectors'>;
};

/**
 * A scratch build that could not start, with the HTTP status its route
 * answers: the file is no model, cannot be read, or the host cannot
 * evaluate text it does not hold.
 */
export class ScratchBuildRefusal extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'ScratchBuildRefusal';
  }
}

/**
 * The numbers a scratch build reports, read off the engine's validation of
 * its scene and its rendered rows. Nothing here touches the kernel.
 */
export class ScratchBuildReport {
  /** Decimals a summed volume is rounded to: the per-shape volumes are already at the unit's precision. */
  private static readonly DECIMALS = 6;

  /** The solids a row list renders: every `solid` shape of a row that is on screen. */
  static solidsOf(objects: any[]): any[] {
    const solids: any[] = [];
    for (const row of objects) {
      if (row?.visible === false) {
        continue;
      }
      for (const shape of (row?.sceneShapes ?? []) as any[]) {
        if (shape?.shapeType === 'solid' && !shape.isMetaShape) {
          solids.push(shape);
        }
      }
    }
    return solids;
  }

  /**
   * Solid count and total volume from the validator's per-shape report —
   * the same pool it examined, each shape once per instance showing it in
   * an assembly. Without a report: the count of rendered solid shapes
   * (a part scene's), and no volume.
   */
  static solids(objects: any[], report: SceneValidationReport | null, assembly: boolean): { solidCount: number; volume: number | null } {
    if (!report) {
      return { solidCount: assembly ? 0 : ScratchBuildReport.solidsOf(objects).length, volume: null };
    }
    let solidCount = 0;
    let volume = 0;
    let measured = false;
    for (const shape of report.shapes) {
      const shown = assembly ? shape.instanceIds?.length ?? 0 : 1;
      solidCount += shape.solids * shown;
      if (shape.volume !== undefined && shown > 0) {
        volume += shape.volume * shown;
        measured = true;
      }
    }
    const scale = 10 ** ScratchBuildReport.DECIMALS;
    return { solidCount, volume: measured ? Math.round(volume * scale) / scale : null };
  }

  /** The validator's report as a scratch build carries it. */
  static validation(report: SceneValidationReport | null): ScratchBuildValidation | null {
    if (!report) {
      return null;
    }
    return {
      ok: report.ok,
      checked: report.checked,
      findings: report.findings.map(({ kind, shapeId, sceneObjectId, part, message }) => ({ kind, shapeId, sceneObjectId, part, message })),
      skipped: report.skipped.length,
    };
  }
}

type StoredBuild = { meshes: ScratchBuildMeshes; weight: number; storedAt: number };

/**
 * The meshes of the scratch builds most recently made, by build id: what
 * `GET /api/scratch-build/:id/meshes` answers a page that draws a tile of
 * one.
 *
 * The rule: **the newest build is always kept**, and older ones while they
 * are younger than {@link MAX_AGE_MS} and fit {@link MAX_BUILDS} and
 * {@link MAX_OLDER_WEIGHT}. A page fetches a build's meshes when it first
 * shows it and keeps the picture it drew; an id that is gone is a build to
 * make again. It holds the plain arrays the render made, never a kernel
 * object — a scratch scene is freed before its build answers.
 */
export class ScratchBuildStore {
  /** How many builds are kept at most, the newest included. */
  static readonly MAX_BUILDS = 12;
  /** How many numbers' worth of older builds are kept beside the newest (see `SceneMeshes.weightOf`). */
  static readonly MAX_OLDER_WEIGHT = 24_000_000;
  /** How long a build is kept at most. */
  static readonly MAX_AGE_MS = 30 * 60_000;

  /** Newest first. */
  private builds: StoredBuild[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  /** A fresh id for a build about to be stored. */
  static newId(): string {
    return randomUUID();
  }

  /** Whether `id` has the form of a build id — what a route checks before it looks one up. */
  static isId(id: unknown): id is string {
    return typeof id === 'string' && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id);
  }

  /** A build was made: its meshes become the newest. */
  put(meshes: ScratchBuildMeshes): void {
    const storedAt = this.now();
    const kept: StoredBuild[] = [{ meshes, weight: ScratchBuildStore.weightOf(meshes.objects), storedAt }];
    let older = 0;
    for (const build of this.builds) {
      if (kept.length >= ScratchBuildStore.MAX_BUILDS || older + build.weight > ScratchBuildStore.MAX_OLDER_WEIGHT) {
        break;
      }
      if (storedAt - build.storedAt > ScratchBuildStore.MAX_AGE_MS) {
        break;
      }
      kept.push(build);
      older += build.weight;
    }
    this.builds = kept;
  }

  /** The meshes of build `id`, or null when it was never made or is no longer kept. */
  get(id: string): ScratchBuildMeshes | null {
    const now = this.now();
    this.builds = this.builds.filter((build, index) => index === 0 || now - build.storedAt <= ScratchBuildStore.MAX_AGE_MS);
    return this.builds.find(build => build.meshes.id === id)?.meshes ?? null;
  }

  /** How many builds and numbers are kept (tests, diagnostics). */
  stats(): { builds: number; weight: number } {
    return { builds: this.builds.length, weight: this.builds.reduce((sum, build) => sum + build.weight, 0) };
  }

  private static weightOf(objects: any[]): number {
    let weight = 0;
    for (const row of objects) {
      for (const list of SceneMeshes.SHAPE_LISTS) {
        for (const shape of (row?.[list] ?? []) as MeshPayload[]) {
          if (Array.isArray(shape?.meshes)) {
            weight += SceneMeshes.weightOf(shape);
          }
        }
      }
    }
    return weight;
  }
}

// Scratch builds: a candidate version of a model file built to see what it would produce, with nothing live touched.

import { createHash, randomUUID } from 'crypto';
import type { FluidScriptKind } from '../file-kind.ts';
import type { LengthUnit } from '../project-config.ts';
import type { CompileError } from '../ws-protocol.ts';
import type { SceneValidationReport } from '../../../lib/dist/index.js';
import type { RenderFingerprint } from '../render-inputs.ts';
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
  /**
   * Answer a kept build of the same inputs instead of building again (see
   * {@link ScratchBuildStore.find}); its outcome then says `reused`. Absent:
   * always build.
   */
  reuse?: boolean;
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
  /**
   * A digest of what the build draws ({@link ScratchBuildReport.geometryOf}):
   * two builds with the same digest render the same meshes in the same
   * places, so a change between them moved no geometry.
   */
  geometry: string;
  /** The answer is a kept build of the same inputs (`reuse`): nothing was built for it. */
  reused?: true;
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
 * What a scratch build of a request would cost, without building it
 * (`FluidCadServer.scratchBuildCost`): nothing when a build of the same
 * inputs is kept — `reusable` is its outcome — and otherwise about
 * `lastBuildMs`, how long the file's last build took (see
 * {@link ModelBuildTimes}); null when this engine process has not built the
 * file yet.
 */
export type ScratchBuildCost = {
  reusable: ScratchBuildOutcome | null;
  lastBuildMs: number | null;
};

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

  /**
   * A digest of what a build draws: every shape of every row on screen, by
   * its kind and the key of its mesh payload (`meshKey`, a digest of the
   * payload's numbers and colours), in order — and, for an assembly, its
   * instances, mates and connectors as serialized, without their source
   * positions. Ids, names and source lines of the rows are left out: a
   * comment or a rename changes none of what is drawn. Equal digests mean
   * the same meshes; two digests that differ may still be the same shape
   * (statements in another order).
   */
  static geometryOf(objects: any[], assembly: unknown | null): string {
    const hash = createHash('sha1');
    for (const row of objects) {
      if (row?.visible === false) {
        continue;
      }
      hash.update('|row');
      for (const shape of (row?.sceneShapes ?? []) as any[]) {
        hash.update(`|${shape?.shapeType ?? ''}:${shape?.isMetaShape ? 'meta' : ''}:`);
        hash.update(typeof shape?.meshKey === 'string' ? shape.meshKey : JSON.stringify(shape?.meshes ?? null));
      }
    }
    if (assembly) {
      hash.update('|assembly');
      hash.update(JSON.stringify(assembly, (key, value) => (key === 'sourceLocation' ? undefined : value)));
    }
    return hash.digest('hex');
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

/** What makes a kept build answer a later request for the same inputs (see {@link ScratchBuildStore.find}). */
export type ScratchBuildReuse = {
  /**
   * The inputs a request names: the file, the text evaluated as it, the
   * session's overrides and configuration, and the request's own params.
   */
  key: string;
  outcome: Exclude<ScratchBuildOutcome, { state: 'compile-error' }>;
  /**
   * Every other file the build read (the modules it imports, the project's
   * `fluidcad.json`, the assets the engine loaded), by content: the build is
   * reused only while these still match.
   */
  fingerprint: RenderFingerprint;
};

type StoredBuild = { meshes: ScratchBuildMeshes; weight: number; storedAt: number; reuse?: ScratchBuildReuse };

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
 *
 * A build stored with its {@link ScratchBuildReuse} also answers a later
 * request for the same inputs ({@link find}) for as long as it is kept: a
 * reused build is one whose meshes can still be drawn. Reusing one makes it
 * the newest ({@link touch}).
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

  /** A build was made: its meshes become the newest. With `reuse`, it answers later requests for the same inputs. */
  put(meshes: ScratchBuildMeshes, reuse?: ScratchBuildReuse): void {
    this.admit({ meshes, weight: ScratchBuildStore.weightOf(meshes.objects), storedAt: this.now(), ...(reuse ? { reuse } : {}) });
  }

  /** The meshes of build `id`, or null when it was never made or is no longer kept. */
  get(id: string): ScratchBuildMeshes | null {
    this.dropOld();
    return this.builds.find(build => build.meshes.id === id)?.meshes ?? null;
  }

  /** The kept build made from the inputs `key` names, newest first, or null. The caller checks its fingerprint. */
  find(key: string): ScratchBuildReuse | null {
    this.dropOld();
    return this.builds.find(build => build.reuse?.key === key)?.reuse ?? null;
  }

  /** Build `id` was reused: it is the newest again, kept as if just made. */
  touch(id: string): void {
    const build = this.builds.find(candidate => candidate.meshes.id === id);
    if (!build) {
      return;
    }
    this.builds = this.builds.filter(candidate => candidate !== build);
    this.admit({ ...build, storedAt: this.now() });
  }

  /** How many builds and numbers are kept (tests, diagnostics). */
  stats(): { builds: number; weight: number } {
    return { builds: this.builds.length, weight: this.builds.reduce((sum, build) => sum + build.weight, 0) };
  }

  private admit(newest: StoredBuild): void {
    const kept: StoredBuild[] = [newest];
    let older = 0;
    for (const build of this.builds) {
      if (kept.length >= ScratchBuildStore.MAX_BUILDS || older + build.weight > ScratchBuildStore.MAX_OLDER_WEIGHT) {
        break;
      }
      if (newest.storedAt - build.storedAt > ScratchBuildStore.MAX_AGE_MS) {
        break;
      }
      kept.push(build);
      older += build.weight;
    }
    this.builds = kept;
  }

  private dropOld(): void {
    const now = this.now();
    this.builds = this.builds.filter((build, index) => index === 0 || now - build.storedAt <= ScratchBuildStore.MAX_AGE_MS);
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

/**
 * How long each model file last took to build in this engine process: what
 * decides whether a build nobody asked for by name (the preview of a change
 * waiting for approval) may hold the engine.
 *
 * Two measures per file. `full`: a build that reused nothing — a scratch
 * build, or a render with no earlier scene of the file to compare against.
 * `render`: its last render of any kind, which may have rebuilt one feature
 * only and so is a floor, not the cost. {@link of} answers the larger of
 * the two: the last full build, unless a later render alone already took
 * longer.
 */
export class ModelBuildTimes {
  /** How many files are remembered; the least recently built goes first. */
  static readonly MAX_FILES = 200;

  private readonly times = new Map<string, { full?: number; render?: number }>();

  /** `file` was built from nothing in `ms`. */
  noteFull(file: string, ms: number): void {
    this.note(file, { full: ms, render: undefined });
  }

  /** A render of `file` took `ms`, with whatever it reused. */
  noteRender(file: string, ms: number): void {
    this.note(file, { render: ms });
  }

  /** How long a build of `file` is expected to take, in ms; null when it was never built here. */
  of(file: string): number | null {
    const known = this.times.get(file);
    if (!known) {
      return null;
    }
    return Math.round(Math.max(known.full ?? 0, known.render ?? 0));
  }

  private note(file: string, change: { full?: number; render?: number }): void {
    const known = this.times.get(file) ?? {};
    this.times.delete(file);
    this.times.set(file, { ...known, ...change });
    for (const oldest of this.times.keys()) {
      if (this.times.size <= ModelBuildTimes.MAX_FILES) {
        break;
      }
      this.times.delete(oldest);
    }
  }
}

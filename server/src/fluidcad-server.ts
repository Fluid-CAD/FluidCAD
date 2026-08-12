import { createHash } from 'crypto';
import { join } from 'path';
import { existsSync } from 'fs';
import type { SceneHost } from './host/scene-host.ts';
import { LocalSceneHost } from './host/local-scene-host.ts';
import { normalizePath } from './normalize-path.ts';
import { detectKind } from './file-kind.ts';
import type { FluidScriptKind } from './file-kind.ts';
import { BreakpointHit } from '../../lib/dist/common/breakpoint-hit.js';
import { createParamRegistry, getParamRegistry } from '../../lib/dist/index.js';
import { scanFileForParts } from './part-catalog/scan.ts';
import type { PartScanResult } from './part-catalog/scan.ts';
import type { ParamDefinition, ParamRegistry, ParamVal } from '../../lib/dist/index.js';
import type { CompileError } from './ws-protocol.ts';

export type SerializedAssembly = {
  instances: Array<{
    instanceId: string;
    partId: string;
    partName: string;
    position: { x: number; y: number; z: number };
    quaternion: { x: number; y: number; z: number; w: number };
    /** EFFECTIVE grounding (scoped-grounding rule already applied by the engine). */
    grounded: boolean;
    /** Owning scope path; "" for root-scope instances. Engines predating sub-assemblies omit it. */
    owner?: string;
    name: string;
    sourceLocation?: { filePath: string; line: number; column: number };
  }>;
  /** Sub-assembly occurrences — absent on engines predating assembly() definitions. */
  occurrences?: Array<{
    occurrenceId: string;
    assemblyName: string;
    name: string;
    parentPath: string;
    position: { x: number; y: number; z: number };
    quaternion: { x: number; y: number; z: number; w: number };
    grounded: boolean;
    groundConnected: boolean;
    sourceLocation?: { filePath: string; line: number; column: number };
  }>;
  mates: Array<{
    mateId: string;
    type: 'fastened' | 'revolute' | 'slider' | 'cylindrical' | 'planar' | 'parallel' | 'pin-slot';
    connectorA: { instanceId: string; connectorId: string };
    connectorB: { instanceId: string; connectorId: string };
    status: 'satisfied' | 'redundant' | 'inconsistent';
    options?: { rotate?: number; flip?: boolean; offset?: [number, number, number]; limits?: [number, number] };
    sourceLocation?: { filePath: string; line: number; column: number };
  }>;
};

type SceneManager = {
  startScene(): any;
  startAssemblyScene(): any;
  renderScene(scene: any): any;
  getAssemblyData(scene: any): SerializedAssembly | null;
  rollbackScene(scene: any, rollbackIndex: number): any;
  compare(previousScene: any, currentScene: any): any;
  // Optional: the manager comes from the workspace's fluidcad install, which
  // may predate scene disposal.
  disposeScene?(scene: any): void;
  setCurrentFile(filePath: string): void;
  importFile(workspacePath: string, fileName: string, data: Uint8Array): any;
  getShapeProperties(scene: any, shapeId: string): any;
  getFaceProperties(scene: any, shapeId: string, faceIndex: number): any;
  getEdgeProperties(scene: any, shapeId: string, edgeIndex: number): any;
  measure(scene: any, refs: { shapeId: string; kind: 'face' | 'edge'; index: number }[]): any;
  explainSelection(
    scene: any,
    refs: { shapeId: string; sub: { type: 'edge' | 'face'; index: number } }[],
    before?: SelectionBoundary,
  ): any;
  synthesizeApplyFeature(
    scene: any,
    refs: { shapeId: string; sub: { type: 'edge' | 'face'; index: number } }[],
    feature: 'fillet' | 'chamfer' | 'shell' | 'sketch' | 'extrude' | 'sweep' | 'loft' | 'plane' | 'revolve' | 'wrap' | 'helix' | 'project' | 'offset' | 'connector',
    value: number | string | undefined,
    chains?: {
      seed: { shapeId: string; sub: { type: 'edge' | 'face'; index: number } };
      members: { shapeId: string; sub: { type: 'edge' | 'face'; index: number } }[];
    }[],
    options?: {
      namer?: (producers: { line: number; nameHint: string }[]) => (string | null)[];
      params?: { name: string; value: number }[];
    },
    before?: SelectionBoundary,
  ): any;
  // Optional: the manager comes from the workspace's fluidcad install, which
  // may predate connector anchor suggestions.
  suggestConnectorAnchors?(
    scene: any,
    ref: { shapeId: string; sub: { type: 'edge' | 'face'; index: number } },
    options?: {
      namer?: (producers: { line: number; nameHint: string }[]) => (string | null)[];
      params?: { name: string; value: number }[];
      connector?: { instance?: { instanceId: string } };
    },
  ): any;
  // Optional: the manager comes from the workspace's fluidcad install, which
  // may predate the 2D target resolver (offset edit seeding). The options
  // arg (text-path seeding needs guides) is ignored by kernels predating it.
  resolveSketchStatementTargets?(scene: any, descriptors: unknown[], options?: { includeGuides?: boolean }): any;
  // Optional: predates the text dialogs' path-layout glyph preview. The
  // path-only options (offset/startAt/flip) are ignored by kernels
  // predating them.
  buildTextPathPreview?(scene: any, request: {
    shapeId: string;
    text: string;
    font?: string;
    weight: number;
    italic: boolean;
    size: number;
    align: string;
    lineSpacing: number;
    letterSpacing: number;
    offset?: number;
    startAt?: number;
    flip?: boolean;
  }): { polylines: number[][] } | { reason: string };
  // Optional: the manager comes from the workspace's fluidcad install, which
  // may predate sketch-scoped selection synthesis.
  synthesizeSketchApplyFeature?(
    scene: any,
    refs: { shapeId: string }[],
    feature: 'fillet' | 'offset' | 'slot' | 'trim' | 'fuse' | 'subtract' | 'common' | 'tarc' | 'text' | 'copy',
    value: number | string | undefined,
    options?: {
      namer?: (producers: { line: number; nameHint: string }[]) => (string | null)[];
      params?: { name: string; value: number }[];
      /** Subtract only: the tool-slot picks (`refs` is the base slot). */
      toolRefs?: { shapeId: string }[];
      /** Copy only: one pick per edge-picked direction, in direction order. */
      axisRefs?: { shapeId: string }[];
      /**
       * Offset only: the dialog's `removeOriginal` argument and `.close()`
       * chain. A workspace kernel predating them ignores the field — the
       * route re-attaches the payload to the returned spec, so the statement
       * the transform writes carries the toggles either way.
       */
      offset?: { removeOriginal: boolean; close: boolean };
      /** Slot only: the dialog's Remove-original toggle (`deleteSource`). */
      slot?: { removeOriginal: boolean };
    },
  ): any;
  // Optional: predates by-region trim synthesis.
  synthesizeTrimRegionTargets?(
    scene: any,
    sourceLocation: { line: number; column?: number },
    edgeIds: string[],
  ): any;
  // Optional: predates segment conversions (sketcher Phase 2a).
  listSegmentConversions?(scene: any, ref: { shapeId: string }): any;
  expandTangentChain(
    scene: any,
    ref: { shapeId: string; sub: { type: 'edge' | 'face'; index: number } },
    before?: SelectionBoundary,
  ): any;
  expandBucket(
    scene: any,
    ref: { shapeId: string; sub: { type: 'edge' | 'face'; index: number } },
    before?: SelectionBoundary,
  ): any;
  listSelectionGroups(
    scene: any,
    ref: { shapeId: string; sub: { type: 'edge' | 'face'; index: number } },
    before?: SelectionBoundary,
  ): any;
  resolveFeatureSources(scene: any, boundary: SelectionBoundary): any;
  // Optional: predates the live dialog geometry preview ("ghost").
  buildFeatureGhost?(scene: any, request: FeatureGhostRequest): any;
  hitTest(
    scene: any,
    shapeId: string,
    rayOrigin: [number, number, number],
    rayDir: [number, number, number],
    edgeThreshold: number,
  ): any;
  exportShapes(
    scene: any,
    shapeIds: string[],
    options: {
      format: 'step' | 'stl';
      includeColors?: boolean;
      resolution?: string;
      customLinearDeflection?: number;
      customAngularDeflectionDeg?: number;
    },
  ): { data: string | Uint8Array; fileName: string };
};

/**
 * A single feature that failed to build during an otherwise successful render.
 * `line`/`column` are 1-based, matching every other `sourceLocation` on the
 * wire.
 */
export type ObjectBuildError = {
  /** Index into the render result — same numbering as `SceneSummary.objects`. */
  index: number;
  id: string;
  name: string;
  uniqueKind: string;
  message: string;
  sourceLocation?: { filePath: string; line: number; column: number };
};

export type SceneRenderedData = {
  absPath: string;
  sceneKind: FluidScriptKind;
  result: any[];
  rollbackStop: number;
  breakpointHit?: boolean;
  assembly?: SerializedAssembly;
  params?: ParamDefinition[];
  /**
   * Features whose `build()` threw. Non-empty means the render completed but
   * the scene is wrong — see `FluidCadServer.collectObjectErrors`.
   */
  objectErrors: ObjectBuildError[];
};

/**
 * A live dialog geometry request ("ghost"), every dialog value already
 * resolved to a number — expression resolution happens in the route, where
 * the file's source is. The kernel builds the bodies the statement would
 * produce and meshes them; nothing is written back to the model.
 */
export type FeatureGhostRequest =
  | ExtrudeGhostRequest
  | RibGhostRequest
  | RevolveGhostRequest
  | SweepGhostRequest
  | LoftGhostRequest
  | FilletGhostRequest
  | HelixGhostRequest
  | RepeatGhostRequest
  | CopyGhostRequest
  | MirrorGhostRequest
  | RotateGhostRequest
  | PlaneGhostRequest
  | OffsetGhostRequest
  | Fillet2DGhostRequest
  | Copy2DGhostRequest;

export type ExtrudeGhostRequest = {
  feature: 'extrude';
  op: 'add' | 'remove' | 'new';
  /** Extrusion distance; null is a through-all cut (`remove` only). */
  distance: number | null;
  distance2: number | null;
  symmetric: boolean;
  draft: number | null;
  /** `.endOffset()` — pulls each swept end back by this much; null for none. */
  endOffset: number | null;
  drill: boolean;
  thin: [number] | [number, number] | null;
  /** The producing statement of the profile to extrude. */
  profile: { filePath: string; line: number };
};

export type RibGhostRequest = {
  feature: 'rib';
  op: 'add' | 'remove' | 'new';
  /** Wall thickness; the sign picks the side of the sketch plane. Nonzero. */
  thickness: number;
  parallel: boolean;
  extend: boolean;
  draft: number | null;
  /** The producing statement of the spine sketch. */
  spine: { filePath: string; line: number };
  /** The `.scope(…)` solids by producing statement; empty means every solid. */
  scope: { filePath: string; line: number }[];
  /** Edit mode: the edited rib's call site — its fusion is unwound. */
  exclude?: { filePath: string; line: number };
};

export type RevolveGhostRequest = {
  feature: 'revolve';
  op: 'add' | 'remove' | 'new';
  /** Sweep angle in degrees. */
  angle: number;
  /** `.symmetric()` — the sweep splits equally across the sketch plane. */
  symmetric: boolean;
  thin: [number] | [number, number] | null;
  /** The producing statement of the profile to revolve. */
  profile: { filePath: string; line: number };
  axis: GhostAxisRef;
};

/**
 * The revolve dialog's axis slot on the wire: a world axis from the X/Y/Z
 * quick buttons, an `axis()` statement by call site, or an edge picked in the
 * viewport. "Keep the current axis" never travels — the client resolves it to
 * the edited statement's own `axis()` call site first.
 */
export type GhostAxisRef =
  | { kind: 'standard'; axis: 'x' | 'y' | 'z' }
  | { kind: 'axis'; filePath: string; line: number }
  | { kind: 'edge'; shapeId: string; index: number };

export type SweepGhostRequest = {
  feature: 'sweep';
  op: 'add' | 'remove' | 'new';
  thin: [number] | [number, number] | null;
  /** The producing statement of the profile to sweep. */
  profile: { filePath: string; line: number };
  path: GhostPathRef;
};

/**
 * The sweep dialog's path slot on the wire: a wire statement by call site — a
 * sketch or a helix — or the edges picked in the viewport, which the apply
 * writes as a selector. As with the revolve's axis, "keep the current path"
 * never travels: the client resolves it to one of the two first.
 */
export type GhostPathRef =
  | { kind: 'wire'; filePath: string; line: number }
  | { kind: 'edges'; entities: { shapeId: string; index: number }[] };

export type LoftGhostRequest = {
  feature: 'loft';
  op: 'add' | 'remove' | 'new';
  thin: [number] | [number, number] | null;
  /** The sections to skin through, in the loft's argument order. */
  profiles: GhostSectionRef[];
  /** Side rails, by producing statement — a sketch or a helix. */
  guides: { filePath: string; line: number }[];
  startCondition: GhostLoftCondition | null;
  endCondition: GhostLoftCondition | null;
};

/**
 * One loft section on the wire: a sketch by call site, or faces picked in the
 * viewport. A chip holds a single pick, but an edit dialog's kept argument
 * resolves to whatever faces its `select()` named — hence the list.
 */
export type GhostSectionRef =
  | { kind: 'sketch'; filePath: string; line: number }
  | { kind: 'faces'; entities: { shapeId: string; index: number }[] };

/** A takeoff condition as the dialog states it (`.startCondition(type, mag)`). */
export type GhostLoftCondition = { type: 'normal' | 'tangent'; magnitude: number };

/**
 * The edge-modifying features. They carry no `op` and no profile: a fillet
 * modifies a solid that is already in the scene, and what the ghost draws is
 * the surfaces it would lay along the picked edges.
 */
export type FilletGhostRequest = {
  feature: 'fillet' | 'chamfer';
  /** Fillet radius, or the chamfer's first distance. */
  value: number;
  /** The chamfer's second value; null is the equal-distance overload. */
  distance2: number | null;
  /** The chamfer's second value is an angle in degrees, not a distance. */
  isAngle: boolean;
  /** The picks, each by the solid it was made on and its index there. */
  edges: GhostEntityRef[];
};

/**
 * A viewport pick: a scene shape, which kind of subshape was clicked, and its
 * index in that shape's mesh order. A face pick means "every edge of that
 * face" — the edge features explode faces at build time.
 */
export type GhostEntityRef = { shapeId: string; index: number; kind: 'edge' | 'face' };

/**
 * The helix. It sweeps nothing and modifies nothing — the feature IS a curve,
 * so its ghost is that curve: no `op`, no profile, just the source it coils
 * around and the dialog's dimensions, each null when the field is empty.
 */
export type HelixGhostRequest = {
  feature: 'helix';
  source: GhostHelixSourceRef;
  radius: number | null;
  endRadius: number | null;
  pitch: number | null;
  turns: number | null;
  height: number | null;
  startOffset: number | null;
  endOffset: number | null;
};

/**
 * The helix dialog's source slot on the wire: the revolve axis family (a world
 * axis, an `axis()` statement, and a picked edge the dialog writes as
 * `axis(<edge>)`), plus the helix's own two — a cylindrical/conical face, and
 * a bare edge source, which only an edit dialog over `helix(select(edge()))`
 * produces.
 */
export type GhostHelixSourceRef =
  | { kind: 'standard'; axis: 'x' | 'y' | 'z' }
  | { kind: 'axis'; filePath: string; line: number }
  | { kind: 'axis-edge'; shapeId: string; index: number }
  | { kind: 'edge'; shapeId: string; index: number }
  | { kind: 'face'; shapeId: string; index: number };

/**
 * The repeat. It builds nothing: the instances it places are the target
 * features themselves, moved — so the ghost stamps the targets' already-meshed
 * shapes at each instance transform rather than replaying the feature, which
 * would cost what the apply costs.
 */
export type RepeatGhostRequest = {
  feature: 'repeat';
  kind: 'linear' | 'circular' | 'mirror' | 'rotate';
  /** The timeline rows being replayed, by call site — the repeat's targets. */
  targets: { filePath: string; line: number }[];
  /** Linear: one per direction (1–2). Circular and rotate: one. Mirror: none. */
  axes: GhostAxisRef[];
  /** The mirror plane; null for every other kind. */
  plane: GhostPlaneRef | null;
  /** Linear: count and spacing per direction, parallel to `axes`. */
  directions: GhostRepeatDirection[];
  /** Linear: center the pattern on the original instead of starting there. */
  centered: boolean;
  /** Circular: instances around the axis, the original included. */
  count: number | null;
  /** Circular: the whole sweep to distribute, or the step between neighbours. */
  sweep: { mode: 'angle' | 'offset'; value: number } | null;
  /** Rotate: how far the single clone turns, in degrees. */
  angle: number | null;
};

/**
 * One linear direction on the wire: how many instances, and how far apart —
 * either directly (`offset`) or as the span they share (`length`). Shared with
 * the copy, which states a direction exactly as the repeat does.
 */
export type GhostRepeatDirection = {
  count: number;
  offset: number | null;
  length: number | null;
};

/**
 * The copy. It builds nothing either, but where a repeat replays the features
 * it names, a copy clones the bodies its targets already hold — so the ghost
 * stamps those bodies whole, which is exactly what the apply will clone.
 */
export type CopyGhostRequest = {
  feature: 'copy';
  kind: 'linear' | 'circular';
  /** The solid-bearing statements being cloned, by call site. */
  targets: { filePath: string; line: number }[];
  /** Linear: one per direction (1–2). Circular: one. */
  axes: GhostAxisRef[];
  /** Linear: count and spacing per direction, parallel to `axes`. */
  directions: GhostRepeatDirection[];
  /** Linear: center the copies on the original instead of starting there. */
  centered: boolean;
  /** Circular: instances around the axis, the original included. */
  count: number | null;
  /** Circular: the whole sweep to divide, or the step between neighbours. */
  sweep: { mode: 'angle' | 'offset'; value: number } | null;
  /**
   * Instances the copy leaves out, one index per direction — a circular
   * copy's entries carry a single index each. Absent skips none.
   */
  skip?: number[][];
};

/**
 * The mirror — the copy's reflected sibling: the target solids' own bodies
 * stamped once, under the same reflection matrix the apply hands OCC.
 */
export type MirrorGhostRequest = {
  feature: 'mirror';
  /** How the reflected bodies land: fused (the default), cut, or standalone. */
  op: 'add' | 'remove' | 'new';
  /** The solid-bearing statements being mirrored, by call site. */
  targets: { filePath: string; line: number }[];
  /** The plane to mirror across. */
  plane: GhostPlaneRef;
};

/**
 * The rotate — the transform sibling of the mirror: the target solids' own
 * bodies stamped once, under the same rotation matrix the apply hands OCC.
 */
export type RotateGhostRequest = {
  feature: 'rotate';
  /** The solid-bearing statements being rotated, by call site. */
  targets: { filePath: string; line: number }[];
  /** The axis to rotate around. */
  axis: GhostAxisRef;
  /** The rotation angle in degrees. */
  angle: number;
};

/**
 * The mirror dialog's plane slot on the wire, the plane sibling of
 * {@link GhostAxisRef}: an origin plane from its viewport quad, a `plane()`
 * statement by call site, or a planar face picked in the viewport. As with the
 * axis, "keep the current plane" never travels.
 */
export type GhostPlaneRef =
  | { kind: 'standard'; plane: 'xy' | 'xz' | 'yz' }
  | { kind: 'plane'; filePath: string; line: number }
  | { kind: 'face'; shapeId: string; index: number };

/**
 * The construction plane. Like the helix it neither adds nor removes material
 * — the ghost is the quad `plane()` would render, in the plane's own yellow —
 * and its bases arrive resolved, in argument order: one for the offset and edge
 * forms, two for a mid plane.
 */
export type PlaneGhostRequest = {
  feature: 'plane';
  type: 'offset' | 'mid' | 'edge';
  bases: GhostPlaneBaseRef[];
  /** Offset along the base normal; null when the field is empty. */
  offset: number | null;
  rotateX: number | null;
  rotateY: number | null;
  rotateZ: number | null;
  /** Edge form: the normalized 0–1 position along the curve. */
  position: number | null;
};

/**
 * The plane dialog's base slot on the wire: the mirror plane's three forms
 * ({@link GhostPlaneRef}), plus the edge form's own two — an edge picked in the
 * viewport, and a statement drawing a single curve (a helix, or a sketch
 * holding one). "Keep the current base" never travels.
 */
export type GhostPlaneBaseRef =
  | GhostPlaneRef
  | { kind: 'wire'; filePath: string; line: number }
  | { kind: 'edge'; shapeId: string; index: number };

/**
 * The 2D offset — the first sketch-op ghost. What an `offset()` adds is
 * curves, so its ghost is the offset wires themselves. The targets are the
 * dialog's picked sketch edges, addressed the way every sketch-op apply
 * addresses them: one shapeId names one sketch edge. An empty list is the
 * `offset(d)` form, which offsets the whole active sketch.
 */
export type OffsetGhostRequest = {
  feature: 'offset';
  /** Signed offset distance. Nonzero. */
  distance: number;
  /** `.close()` — cap an open offset back onto its source with two straight edges. */
  close: boolean;
  /** The picked sketch edges (1 shapeId = 1 edge); empty offsets the whole sketch. */
  entities: { shapeId: string }[];
};

/**
 * The 2D fillet — keyed `fillet2d` on the wire because plain `fillet` already
 * names the 3D band ghost. What comes back is only the new corner arcs: the
 * trimmed survivors lie on the sketch's own lines. The targets are the
 * dialog's picked sketch edges (one shapeId names one sketch edge); an empty
 * list is the `fillet(r)` form, which fillets the whole active sketch.
 */
export type Fillet2DGhostRequest = {
  feature: 'fillet2d';
  /** Corner radius. Positive. */
  radius: number;
  /** The picked sketch edges (1 shapeId = 1 edge); empty fillets the whole sketch. */
  entities: { shapeId: string }[];
};

/**
 * The in-sketch copy — keyed `copy2d` on the wire because plain `copy`
 * already names the 3D body-stamping ghost. Like its 3D twin it builds
 * nothing: the clones a `copy()` places inside a sketch are its targets' own
 * curves, moved, so the ghost stamps those curves' meshes at each instance
 * transform. Targets travel as on every sketch-op path (1 shapeId = 1 sketch
 * edge), each pick standing for its whole producing primitive; an empty list
 * is the target-less statement form, which copies the whole active sketch.
 */
export type Copy2DGhostRequest = {
  feature: 'copy2d';
  kind: 'linear' | 'circular';
  /** The picked sketch edges; empty copies the whole active sketch. */
  entities: { shapeId: string }[];
  /** Linear: one per direction (1–2). Circular: none — the center serves. */
  axes: GhostSketchAxisRef[];
  /** Linear: count and spacing per direction, parallel to `axes`. */
  directions: GhostRepeatDirection[];
  /** Linear: center the copies on the original instead of starting there. */
  centered: boolean;
  /** Circular: the rotation center, in sketch coordinates. */
  center: [number, number] | null;
  /** Circular: instances around the center, the original included. */
  count: number | null;
  /** Circular: the whole sweep to divide, or the step between neighbours. */
  sweep: { mode: 'angle' | 'offset'; value: number } | null;
  /**
   * Instances the copy leaves out, one index per direction — a circular
   * copy's entries carry a single index each. Absent skips none.
   */
  skip?: number[][];
};

/**
 * The 2D copy dialog's direction slot on the wire: a sketch-local axis from
 * the Local X / Local Y quick buttons (`local('x')`), or a picked sketch line
 * the apply writes as `axis(<var>)`. A top-level `axis()` statement never
 * appears here, and "keep the current axis" only travels once it reads back
 * as a local form.
 */
export type GhostSketchAxisRef =
  | { kind: 'local'; axis: 'x' | 'y' }
  | { kind: 'edge'; shapeId: string };

/**
 * One ghost body's meshes, in the same wire format a rendered solid uses.
 * `kind` overrides the overlay's per-dialog color for this body alone — a
 * fillet takes material away at one edge and puts it back at the next; `plane`
 * carries a construction plane's own frame, which the overlay draws its normal
 * arrow from.
 */
export type GhostSolid = {
  meshes: any[];
  kind?: 'add' | 'remove';
  plane?: { normal: { x: number; y: number; z: number }; center: { x: number; y: number; z: number } };
};

/**
 * A ghost outcome plus the status the route should answer with. `solids`
 * present is the success case; otherwise `reason` says why, and a refusal the
 * dialog hits while simply typing (a superseded request, a profile not in the
 * scene yet) stays a 200 the client silently clears on rather than an error.
 */
export type FeatureGhostOutcome = {
  status: number;
  solids?: GhostSolid[];
  reason?: string;
  /**
   * The reason is worth putting in front of the user — a limit they can act
   * on, not one of the many ordinary mid-composition refusals a dialog would
   * only flash noise about. Unset means the client clears and says nothing.
   */
  surface?: boolean;
};

/**
 * Boundary for edit-mode selection queries: the statement being edited,
 * addressed by scene position (timeline row) and call site. Queries carrying
 * one resolve against the objects strictly before it — the world that
 * statement's arguments see at build time. Validation (index still holds
 * that call site) happens kernel-side; a stale boundary refuses.
 */
export type SelectionBoundary = {
  index: number;
  type: string;
  line: number;
  column: number;
};

export type SceneSummaryObject = {
  index: number;
  id: string;
  kind: string;
  uniqueKind: string;
  name: string;
  params: any;
  sourceLocation?: { filePath: string; line: number; column: number };
  shapeIds: string[];
  fromCache: boolean;
  hasError: boolean;
  errorMessage?: string;
  containerId: string | null;
  isContainer: boolean;
  visible: boolean;
};

export type SceneSummary = {
  schemaVersion: 1;
  file: string;
  objects: SceneSummaryObject[];
  rollbackStop: number;
  compileError: CompileError | null;
};

export type ShapeListEntry = {
  shapeId: string;
  type: string;
  sceneObjectId: string;
};

export type ShapeList = {
  shapes: ShapeListEntry[];
};

/**
 * `sessionId` is the per-renderer state key. In desktop mode it equals the
 * file path being edited (so per-file state survives switching files). In
 * hub mode it's a WebSocket connection UUID (so concurrent viewers stay
 * isolated). Map keys called `sessionId` accept either flavour.
 */

export class FluidCadServer {
  private host: SceneHost;
  private sceneManager: SceneManager | undefined;

  // Per-session render output, scene cache, and param overrides. Desktop's
  // sessionId is the normalized filePath; hub mode's sessionId is the WS
  // connection UUID. Maps must be cleared via `destroySession` on hub-side
  // disconnect to avoid leaks.
  private previousScenes: Map<string, any> = new Map();
  private renderingCache = new Map<string, { result: any[]; assembly?: SerializedAssembly }>();
  // Records the last successful render per session as `{ paramsHash, data }`.
  // Any subsequent render request short-circuits when the new params hash to
  // the same value — avoids redundant OCC work when desktop producers see the
  // same code+params, or hub clients re-emit the same param mutation.
  private lastRendered = new Map<string, { paramsHash: string; data: SceneRenderedData }>();
  private paramOverrides: Map<string, Map<string, any>> = new Map();
  // Per session, the default each `param()` was authored with as of the last
  // render — `label → the literal in the source`. An override is a delta over
  // that default, so when the file re-declares it the override is stale and
  // gets dropped instead of shadowing the value the code now asks for.
  private lastParamDefaults = new Map<string, Map<string, ParamVal>>();
  // What file each session is rendering. For desktop, sessionId === filePath
  // (set lazily on first processFile call). For hub, set explicitly via
  // createSession with the bundle's manifest entry.
  private sessionFiles = new Map<string, string>();

  // Serializes OCC calls across all sessions. OCC isn't thread-safe and we
  // share one engine instance per host process; concurrent param edits from
  // multiple hub clients have to queue. Promise-chain pattern: each render
  // awaits the previous one's settlement before starting.
  private renderMutex: Promise<unknown> = Promise.resolve();

  // Monotonic ghost-request counter. Dialog previews arrive per keystroke and
  // queue behind the mutex; one whose successor already landed skips its OC
  // work rather than meshing geometry nobody will draw.
  private ghostGeneration = 0;

  private currentFileName: string = '';
  private currentFilePath: string = '';
  private lastRollbackStop: number = -1;
  /**
   * Whether the last full render paused at a breakpoint. Rollbacks don't
   * re-run the module, so they carry this last known state — without it the
   * UI's breakpoint indicator can't survive a browser refresh whose replayed
   * scene message is a rollback broadcast.
   */
  private lastBreakpointHit = false;
  private compileError: CompileError | null = null;

  constructor(host: SceneHost = new LocalSceneHost()) {
    this.host = host;
  }

  getCurrentCode(): string | null {
    if (!this.currentFileName) return null;
    return this.host.getBuffer(this.currentFileName);
  }

  /** Param definitions from the last render — currentValue is override-aware. */
  getParamDefinitions(): { label: string; currentValue: unknown }[] {
    return getParamRegistry().getDefinitions();
  }

  async init(workspacePath: string) {
    await this.host.init(workspacePath);

    const initFilePath = normalizePath(join(workspacePath, 'init.js'));
    if (existsSync(initFilePath)) {
      const { default: _sceneManager } = await this.host.loadModule(initFilePath);
      this.sceneManager = await _sceneManager;
    }
  }

  /**
   * Capture an already-initialized SceneManager. Used by the hub-mode entry
   * after running the packed bundle once to materialize the engine globals.
   */
  setSceneManager(manager: SceneManager): void {
    this.sceneManager = manager;
  }

  /**
   * Run `fn` with exclusive access to the OCC engine. The mutex is process-
   * wide: in hub mode concurrent client sessions land here too. Order is
   * first-come, first-served via Promise chain.
   */
  private async serialized<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.renderMutex;
    let release: () => void = () => {};
    const next = new Promise<void>((resolve) => { release = resolve; });
    this.renderMutex = next;
    try {
      await prev;
      return await fn();
    } finally {
      release();
    }
  }

  // ---------------------------------------------------------------------------
  // Session lifecycle (hub mode)
  // ---------------------------------------------------------------------------

  createSession(sessionId: string, entryFilePath: string): void {
    this.sessionFiles.set(sessionId, normalizePath(entryFilePath));
  }

  destroySession(sessionId: string): void {
    const scene = this.previousScenes.get(sessionId);
    if (scene) {
      this.sceneManager?.disposeScene?.(scene);
    }
    this.previousScenes.delete(sessionId);
    this.renderingCache.delete(sessionId);
    this.lastRendered.delete(sessionId);
    this.paramOverrides.delete(sessionId);
    this.lastParamDefaults.delete(sessionId);
    this.sessionFiles.delete(sessionId);
  }

  /**
   * Re-render the session's entry, ignoring caches. Hub clients call this
   * after editing a param. Returns the fresh render or null if no manager.
   */
  async recomputeForSession(sessionId: string): Promise<SceneRenderedData | null> {
    const filePath = this.sessionFiles.get(sessionId);
    if (!filePath) return null;
    this.renderingCache.delete(sessionId);
    this.lastRendered.delete(sessionId);
    return this.processFileInternal(sessionId, filePath, true);
  }

  // ---------------------------------------------------------------------------
  // Render — internal core used by both desktop and hub entry points
  // ---------------------------------------------------------------------------

  private async processFileInternal(
    sessionId: string,
    filePath: string,
    ignoreCache: boolean,
  ): Promise<SceneRenderedData | null> {
    return this.serialized(async () => {
      if (!this.sceneManager) {
        return null;
      }

      const normalizedFileName = filePath.replace('virtual:live-render:', '');
      this.currentFileName = normalizedFileName;
      this.currentFilePath = filePath;

      const sceneKind: FluidScriptKind = detectKind(normalizedFileName) ?? 'part';

      if (!ignoreCache) {
        const fromCache = this.renderingCache.get(sessionId);
        if (fromCache) {
          this.lastRollbackStop = fromCache.result.length - 1;
          this.compileError = null;
          return {
            absPath: normalizedFileName,
            sceneKind,
            result: fromCache.result,
            rollbackStop: fromCache.result.length - 1,
            breakpointHit: this.lastBreakpointHit,
            objectErrors: FluidCadServer.collectObjectErrors(fromCache.result),
            ...(fromCache.assembly ? { assembly: fromCache.assembly } : {}),
          };
        }
      }

      try {
        let scene = sceneKind === 'assembly'
          ? this.sceneManager.startAssemblyScene()
          : this.sceneManager.startScene();
        this.sceneManager.setCurrentFile(normalizedFileName);
        this.host.invalidateModule();

        const registry = createParamRegistry();
        const overrides = this.paramOverrides.get(sessionId);
        if (overrides) {
          registry.setOverrides(overrides, this.lastParamDefaults.get(sessionId));
        }

        let breakpointHit = false;
        try {
          await this.host.loadModule(filePath);
        }
        catch (e) {
          if (e instanceof BreakpointHit) {
            breakpointHit = true;
          } else {
            throw e;
          }
        }
        this.lastBreakpointHit = breakpointHit;

        const params = getParamRegistry().getDefinitions();
        this.settleParamOverrides(sessionId, registry);

        if (this.previousScenes.has(sessionId)) {
          const previousScene = this.previousScenes.get(sessionId);
          scene = this.sceneManager.compare(previousScene, scene);
        }

        this.previousScenes.set(sessionId, scene);

        this.sceneManager.renderScene(scene);
        const result = scene.getRenderedObjects();

        for (const obj of result) {
          if (obj.sourceLocation) {
            obj.sourceLocation.filePath = obj.sourceLocation.filePath.replace('virtual:live-render:', '');
          }
        }

        const assembly = this.sceneManager.getAssemblyData(scene);
        if (assembly) {
          for (const inst of assembly.instances) {
            if (inst.sourceLocation) {
              inst.sourceLocation.filePath = inst.sourceLocation.filePath.replace('virtual:live-render:', '');
            }
          }
          for (const mate of assembly.mates) {
            if (mate.sourceLocation) {
              mate.sourceLocation.filePath = mate.sourceLocation.filePath.replace('virtual:live-render:', '');
            }
          }
          for (const occ of assembly.occurrences ?? []) {
            if (occ.sourceLocation) {
              occ.sourceLocation.filePath = occ.sourceLocation.filePath.replace('virtual:live-render:', '');
            }
          }
        }

        if (!filePath.startsWith('virtual:live-render')) {
          this.renderingCache.set(sessionId, assembly ? { result, assembly } : { result });
        }

        this.lastRollbackStop = result.length - 1;
        this.compileError = null;

        return {
          absPath: normalizedFileName,
          sceneKind,
          result,
          rollbackStop: result.length - 1,
          breakpointHit,
          params,
          objectErrors: FluidCadServer.collectObjectErrors(result),
          ...(assembly ? { assembly } : {}),
        };
      }
      catch (error) {
        this.host.invalidateModule();
        console.log('Error processing file:', error);
        throw error;
      }
    });
  }

  /**
   * Close the loop on a render's param bookkeeping: remember what each
   * `param()` declared so the next render can tell an edited default from an
   * unchanged one, and forget the overrides this render found stale.
   *
   * Baselines merge rather than replace — a param that didn't run this pass
   * (breakpoint, untaken branch) keeps the default it last declared, so an
   * edit to *its* literal is still recognized later. Absence alone never
   * drops an override for the same reason: not running is not un-declaring.
   */
  private settleParamOverrides(sessionId: string, registry: ParamRegistry): void {
    const baselines = this.lastParamDefaults.get(sessionId) ?? new Map<string, ParamVal>();
    for (const [label, authored] of registry.getAuthoredDefaults()) {
      baselines.set(label, authored);
    }
    this.lastParamDefaults.set(sessionId, baselines);

    const discarded = registry.getDiscardedOverrides();
    const overrides = this.paramOverrides.get(sessionId);
    if (!overrides || discarded.length === 0) {
      return;
    }
    for (const label of discarded) {
      overrides.delete(label);
    }
    if (overrides.size === 0) {
      this.paramOverrides.delete(sessionId);
    }
  }

  // ---------------------------------------------------------------------------
  // Desktop API — sessionId is implicit (filePath)
  // ---------------------------------------------------------------------------

  async processFile(filePath: string, ignoreCache = false): Promise<SceneRenderedData | null> {
    filePath = normalizePath(filePath);
    const sessionId = filePath.replace('virtual:live-render:', '');
    this.sessionFiles.set(sessionId, sessionId);
    return this.processFileInternal(sessionId, filePath, ignoreCache);
  }

  async updateLiveCode(fileName: string, code: string): Promise<SceneRenderedData | null> {
    fileName = normalizePath(fileName);

    // Dedup against the last successful render. Multiple producers (editor
    // live-update, save-triggered process-file, watcher, MCP /api/render)
    // commonly hand us identical content; without this short-circuit each
    // would trigger a redundant OCC pass. paramsHash mixes code content with
    // current param overrides so a param change invalidates the cache.
    const paramsHash = this.computeParamsHash(fileName, code);
    const cached = this.lastRendered.get(fileName);
    if (cached && cached.paramsHash === paramsHash) {
      // Keep the live-render buffer in sync even when the render itself is
      // deduped. The module loader serves this overlay for the raw file path
      // too (save-triggered process-file), so skipping the update would leave
      // a stale overlay from an earlier broken live-update — the next save
      // would then compile the old broken code and report its error even
      // though editor and disk both hold valid content.
      this.host.setBuffer(`virtual:live-render:${fileName}`, code);
      this.compileError = null;
      this.currentFileName = fileName;
      this.currentFilePath = `virtual:live-render:${fileName}`;
      this.lastRollbackStop = cached.data.rollbackStop;
      return cached.data;
    }

    const id = `virtual:live-render:${fileName}`;
    this.host.setBuffer(id, code);
    this.renderingCache.delete(fileName);
    this.sessionFiles.set(fileName, fileName);
    const result = await this.processFileInternal(fileName, id, true);
    if (result) {
      // Re-hash after the render, not before: a render can drop param
      // overrides the source re-declared, and a key cut from the pre-render
      // overrides would never match again — every later keystroke on
      // identical code would re-render.
      this.lastRendered.set(fileName, { paramsHash: this.computeParamsHash(fileName, code), data: result });
    }
    return result;
  }

  /**
   * Fold an edited DEPENDENCY's code in — a part file rewritten by a
   * cross-file edit (the assembly mate dialog's connector flows) while an
   * assembly is being viewed — and re-render the CURRENT file against it.
   * The updated file gets the same live-buffer overlay `updateLiveCode`
   * would set; the current file's dedup entries are dropped so this render
   * (and any later identical live-update) sees the new dependency; the
   * current scene/file identity is left untouched.
   */
  async updateDependencyCode(fileName: string, code: string): Promise<SceneRenderedData | null> {
    fileName = normalizePath(fileName);
    this.host.setBuffer(`virtual:live-render:${fileName}`, code);
    this.lastRendered.delete(fileName);
    const current = this.currentFileName;
    if (!current) {
      return null;
    }
    this.renderingCache.delete(current);
    this.lastRendered.delete(current);
    return this.processFileInternal(current, this.currentFilePath ?? current, true);
  }

  async rollbackFromUI(index: number): Promise<SceneRenderedData | null> {
    return this.rollback(this.currentFileName, index);
  }

  /**
   * Evaluate one candidate file and inspect its exports for insertable parts
   * (Insert dialog). Serialized with renders on the OCC mutex; the scan runs
   * in throwaway scenes and touches neither the session caches nor the
   * compare baselines, so the live session's incremental rebuilds are
   * unaffected. Returns null before init.
   */
  async scanPartsInFile(filePath: string): Promise<PartScanResult | null> {
    return this.serialized(async () => {
      if (!this.sceneManager) {
        return null;
      }
      return scanFileForParts(this.host, this.sceneManager, normalizePath(filePath));
    });
  }

  /**
   * Whether the host holds a live editor buffer overlaying this file — such
   * files must never be served from a disk-mtime-keyed scan cache, and their
   * candidate prefilter should read the buffer, not the disk.
   */
  hasLiveBuffer(filePath: string): boolean {
    return this.host.getBuffer(normalizePath(filePath)) !== null;
  }

  /** The live buffer's content for a file, if the host holds one. */
  getLiveBuffer(filePath: string): string | null {
    return this.host.getBuffer(normalizePath(filePath));
  }

  async recomputeCurrentFile(forceFullRebuild = false): Promise<SceneRenderedData | null> {
    if (!this.currentFilePath) {
      return null;
    }
    const sessionId = this.currentFileName;
    this.renderingCache.delete(sessionId);
    this.lastRendered.delete(sessionId);
    if (forceFullRebuild) {
      // Drop the incremental-compare baseline so every object is rebuilt from
      // scratch instead of being carried over as cached. Without this, an
      // unchanged file compares equal at every index, the whole scene is
      // marked cached, and the render reuses all geometry — so the explicit
      // "Recompute scene" action does no visible work and reports no build
      // timings (buildDurationMs is only recorded for objects that rebuild).
      // Param edits keep the baseline so slider drags stay fast.
      const staleScene = this.previousScenes.get(sessionId);
      if (staleScene) {
        this.sceneManager?.disposeScene?.(staleScene);
      }
      this.previousScenes.delete(sessionId);
    }
    return this.processFileInternal(sessionId, this.currentFilePath, true);
  }

  async rollback(fileName: string, index: number): Promise<SceneRenderedData | null> {
    if (!this.sceneManager) {
      return null;
    }

    const scene = this.previousScenes.get(fileName);
    if (!scene) {
      return null;
    }

    const totalObjects = scene.getAllSceneObjects().length;

    const rollbackIndex = index >= totalObjects - 1 ? totalObjects - 1 : index;
    this.sceneManager.rollbackScene(scene, rollbackIndex);
    const result = scene.getRenderedObjects();
    const assembly = this.sceneManager.getAssemblyData(scene);

    this.lastRollbackStop = index;

    return {
      absPath: fileName,
      sceneKind: detectKind(fileName) ?? 'part',
      result,
      rollbackStop: index,
      // A rollback doesn't re-run the module — the paused state persists.
      breakpointHit: this.lastBreakpointHit,
      objectErrors: FluidCadServer.collectObjectErrors(result),
      ...(assembly ? { assembly } : {}),
    };
  }

  async importFile(workspacePath: string, fileName: string, data: string): Promise<void> {
    if (!this.sceneManager) {
      throw new Error('SceneManager not initialized');
    }

    const binaryData = Buffer.from(data, 'base64');
    await this.sceneManager.importFile(workspacePath, fileName, binaryData);
  }

  getShapeProperties(shapeId: string): any {
    if (!this.sceneManager) {
      return null;
    }
    const scene = this.previousScenes.get(this.currentFileName);
    if (!scene) {
      return null;
    }
    return this.sceneManager.getShapeProperties(scene, shapeId);
  }

  getFaceProperties(shapeId: string, faceIndex: number): any {
    if (!this.sceneManager) {
      return null;
    }
    const scene = this.previousScenes.get(this.currentFileName);
    if (!scene) {
      return null;
    }
    return this.sceneManager.getFaceProperties(scene, shapeId, faceIndex);
  }

  getEdgeProperties(shapeId: string, edgeIndex: number): any {
    if (!this.sceneManager) {
      return null;
    }
    const scene = this.previousScenes.get(this.currentFileName);
    if (!scene) {
      return null;
    }
    return this.sceneManager.getEdgeProperties(scene, shapeId, edgeIndex);
  }

  measure(refs: { shapeId: string; kind: 'face' | 'edge'; index: number }[]): any {
    if (!this.sceneManager) {
      return null;
    }
    const scene = this.previousScenes.get(this.currentFileName);
    if (!scene) {
      return null;
    }
    return this.sceneManager.measure(scene, refs);
  }

  explainSelection(
    refs: { shapeId: string; sub: { type: 'edge' | 'face'; index: number } }[],
    before?: SelectionBoundary,
  ): any {
    if (!this.sceneManager) {
      return null;
    }
    const scene = this.previousScenes.get(this.currentFileName);
    if (!scene) {
      return null;
    }
    return this.sceneManager.explainSelection(scene, refs, before);
  }

  /**
   * Mesh the geometry an open feature dialog would produce, for the client
   * that asked. A side channel by design: it reads the live scene and writes
   * nothing back — no code, no scene state, no `scene-rendered` broadcast, no
   * mesh cached onto a scene shape — and the shapes it builds are freed
   * before it answers.
   *
   * All of that runs under `serialized`, so a render can't interleave with
   * the OCC calls. Requests arrive per keystroke: one that finds a newer
   * request already accepted drops out before doing any geometry work, and
   * the client discards its answer anyway.
   */
  async featureGhost(request: FeatureGhostRequest): Promise<FeatureGhostOutcome> {
    const generation = ++this.ghostGeneration;
    return this.serialized(async () => {
      if (generation !== this.ghostGeneration) {
        return { status: 200, reason: 'Superseded by a newer preview.' };
      }
      if (!this.sceneManager?.buildFeatureGhost) {
        return { status: 422, reason: 'This workspace kernel has no live geometry preview.' };
      }
      const scene = this.previousScenes.get(this.currentFileName);
      if (!scene) {
        return { status: 422, reason: 'No rendered scene' };
      }
      try {
        const result = this.sceneManager.buildFeatureGhost(scene, request);
        if (result?.ok) {
          return { status: 200, solids: (result.solids ?? []) as GhostSolid[] };
        }
        return {
          status: 422,
          reason: result?.reason ?? 'Could not build the preview geometry.',
          surface: result?.surface === true || undefined,
        };
      } catch (err: any) {
        // A profile OCC can't sweep at the current values is an ordinary
        // mid-typing state — the dialog just shows no ghost.
        return { status: 200, reason: err?.message ?? 'Could not build the preview geometry.' };
      }
    });
  }

  synthesizeApplyFeature(
    refs: { shapeId: string; sub: { type: 'edge' | 'face'; index: number } }[],
    feature: 'fillet' | 'chamfer' | 'shell' | 'sketch' | 'extrude' | 'sweep' | 'loft' | 'plane' | 'revolve' | 'wrap' | 'helix' | 'project' | 'offset' | 'connector',
    value: number | string | undefined,
    chains: {
      seed: { shapeId: string; sub: { type: 'edge' | 'face'; index: number } };
      members: { shapeId: string; sub: { type: 'edge' | 'face'; index: number } }[];
    }[] = [],
    options?: {
      namer?: (producers: { line: number; nameHint: string }[]) => (string | null)[];
      params?: { name: string; value: number }[];
      connector?: {
        anchor?: { kind: string; mode?: string; value?: number };
        rotate?: { axis: 'x' | 'y' | 'z'; angle: number };
        offset?: [number, number, number];
        instance?: { instanceId: string };
      };
    },
    before?: SelectionBoundary,
  ): any {
    if (!this.sceneManager) {
      return null;
    }
    const scene = this.previousScenes.get(this.currentFileName);
    if (!scene) {
      return null;
    }
    return this.sceneManager.synthesizeApplyFeature(scene, refs, feature, value, chains, options, before);
  }

  /**
   * Hover-time connector anchor suggestions for a picked face/edge: exact
   * anchor frames plus the synthesized source expression and a free default
   * name. Read-only over the rendered scene.
   */
  suggestConnectorAnchors(
    ref: { shapeId: string; sub: { type: 'edge' | 'face'; index: number } },
    options?: {
      namer?: (producers: { line: number; nameHint: string }[]) => (string | null)[];
      params?: { name: string; value: number }[];
      connector?: { instance?: { instanceId: string } };
    },
  ): any {
    if (!this.sceneManager) {
      return null;
    }
    if (!this.sceneManager.suggestConnectorAnchors) {
      // Workspace kernel predates connector anchor suggestions.
      return { ok: false, reason: 'the workspace fluidcad version does not support connector suggestions — update fluidcad' };
    }
    const scene = this.previousScenes.get(this.currentFileName);
    if (!scene) {
      return null;
    }
    return this.sceneManager.suggestConnectorAnchors(scene, ref, options);
  }

  /** 2D branch: synthesize a sketch-body statement for picked sketch edges. */
  synthesizeSketchApplyFeature(
    refs: { shapeId: string }[],
    feature: 'fillet' | 'offset' | 'slot' | 'trim' | 'fuse' | 'subtract' | 'common' | 'tarc' | 'text' | 'copy',
    value: number | string | undefined,
    options?: {
      namer?: (producers: { line: number; nameHint: string }[]) => (string | null)[];
      params?: { name: string; value: number }[];
      /** Subtract only: the tool-slot picks (`refs` is the base slot). */
      toolRefs?: { shapeId: string }[];
      /** Copy only: one pick per edge-picked direction, in direction order. */
      axisRefs?: { shapeId: string }[];
      /** Offset only: the dialog's `removeOriginal` argument and `.close()` chain. */
      offset?: { removeOriginal: boolean; close: boolean };
      /** Slot only: the dialog's Remove-original toggle (`deleteSource`). */
      slot?: { removeOriginal: boolean };
    },
  ): any {
    if (!this.sceneManager?.synthesizeSketchApplyFeature) {
      return null;
    }
    const scene = this.previousScenes.get(this.currentFileName);
    if (!scene) {
      return null;
    }
    return this.sceneManager.synthesizeSketchApplyFeature(scene, refs, feature, value, options);
  }

  /**
   * Resolve a 2D statement's parsed target arguments onto the active
   * sketch's edges — the offset edit dialog's seed/highlight.
   */
  resolveSketchStatementTargets(descriptors: unknown[], options?: { includeGuides?: boolean }): any {
    if (!this.sceneManager?.resolveSketchStatementTargets) {
      return null;
    }
    const scene = this.previousScenes.get(this.currentFileName);
    if (!scene) {
      return null;
    }
    return this.sceneManager.resolveSketchStatementTargets(scene, descriptors, options);
  }

  /**
   * Glyph outlines laid along a picked path geometry — the text dialogs'
   * preview. Null without a scene; a `reason` result when the workspace's
   * fluidcad predates the preview builder or the layout refuses.
   */
  buildTextPathPreview(request: {
    shapeId: string;
    text: string;
    font?: string;
    weight: number;
    italic: boolean;
    size: number;
    align: string;
    lineSpacing: number;
    letterSpacing: number;
    offset?: number;
    startAt?: number;
    flip?: boolean;
  }): { polylines: number[][] } | { reason: string } | null {
    if (!this.sceneManager?.buildTextPathPreview) {
      return { reason: "the workspace's FluidCAD version does not support the text path preview — update its fluidcad dependency" };
    }
    const scene = this.previousScenes.get(this.currentFileName);
    if (!scene) {
      return null;
    }
    return this.sceneManager.buildTextPathPreview(scene, request);
  }

  /** By-region trim: synthesize filter args for a clicked region's boundary segments. */
  synthesizeTrimRegionTargets(
    sourceLocation: { line: number; column?: number },
    edgeIds: string[],
  ): any {
    if (!this.sceneManager?.synthesizeTrimRegionTargets) {
      return null;
    }
    const scene = this.previousScenes.get(this.currentFileName);
    if (!scene) {
      return null;
    }
    return this.sceneManager.synthesizeTrimRegionTargets(scene, sourceLocation, edgeIds);
  }

  expandTangentChain(
    ref: { shapeId: string; sub: { type: 'edge' | 'face'; index: number } },
    before?: SelectionBoundary,
  ): any {
    if (!this.sceneManager) {
      return null;
    }
    const scene = this.previousScenes.get(this.currentFileName);
    if (!scene) {
      return null;
    }
    return this.sceneManager.expandTangentChain(scene, ref, before);
  }

  expandBucket(
    ref: { shapeId: string; sub: { type: 'edge' | 'face'; index: number } },
    before?: SelectionBoundary,
  ): any {
    if (!this.sceneManager) {
      return null;
    }
    const scene = this.previousScenes.get(this.currentFileName);
    if (!scene) {
      return null;
    }
    return this.sceneManager.expandBucket(scene, ref, before);
  }

  listSelectionGroups(
    ref: { shapeId: string; sub: { type: 'edge' | 'face'; index: number } },
    before?: SelectionBoundary,
  ): any {
    if (!this.sceneManager) {
      return null;
    }
    const scene = this.previousScenes.get(this.currentFileName);
    if (!scene) {
      return null;
    }
    return this.sceneManager.listSelectionGroups(scene, ref, before);
  }

  /** Legal constrained/free conversions for a picked chained sketch segment. */
  listSegmentConversions(ref: { shapeId: string }): any {
    if (!this.sceneManager?.listSegmentConversions) {
      return null;
    }
    const scene = this.previousScenes.get(this.currentFileName);
    if (!scene) {
      return null;
    }
    return this.sceneManager.listSegmentConversions(scene, ref);
  }

  /** Current sources of the statement at `before`, for edit-dialog seeding. */
  featureSources(before: SelectionBoundary): any {
    if (!this.sceneManager) {
      return null;
    }
    const scene = this.previousScenes.get(this.currentFileName);
    if (!scene) {
      return null;
    }
    return this.sceneManager.resolveFeatureSources(scene, before);
  }

  exportShapes(
    shapeIds: string[],
    options: {
      format: 'step' | 'stl';
      includeColors?: boolean;
      resolution?: string;
      customLinearDeflection?: number;
      customAngularDeflectionDeg?: number;
    },
  ): { data: string | Uint8Array; fileName: string } | null {
    if (!this.sceneManager) {
      return null;
    }
    const scene = this.previousScenes.get(this.currentFileName);
    if (!scene) {
      return null;
    }
    return this.sceneManager.exportShapes(scene, shapeIds, options);
  }

  /**
   * Export every solid of a hub session's latest render. The session-keyed twin
   * of `exportShapes` (which reads the desktop `currentFileName`): hub mode keys
   * each render's scene by `sessionId`, so exporting/downloading from a hub
   * session must look it up the same way — exactly why `hitTestForSession`
   * exists. Gathers all solids itself ("download the whole model"); returns null
   * when the session has no rendered scene or it holds no solids (the caller maps
   * that to a "nothing to export" response).
   */
  exportShapesForSession(
    sessionId: string,
    options: {
      format: 'step' | 'stl';
      includeColors?: boolean;
      resolution?: string;
      customLinearDeflection?: number;
      customAngularDeflectionDeg?: number;
    },
  ): { data: string | Uint8Array; fileName: string } | null {
    if (!this.sceneManager) {
      return null;
    }
    const scene = this.previousScenes.get(sessionId);
    if (!scene) {
      return null;
    }
    const shapeIds: string[] = [];
    for (const obj of scene.getAllSceneObjects()) {
      for (const shape of obj.getAddedShapes()) {
        if (shape.isSolid()) {
          shapeIds.push(shape.id);
        }
      }
    }
    if (shapeIds.length === 0) {
      return null;
    }
    return this.sceneManager.exportShapes(scene, shapeIds, options);
  }

  hitTest(
    shapeId: string,
    rayOrigin: [number, number, number],
    rayDir: [number, number, number],
    edgeThreshold: number,
  ): any {
    if (!this.sceneManager) {
      return null;
    }
    const scene = this.previousScenes.get(this.currentFileName);
    if (!scene) {
      return null;
    }
    return this.sceneManager.hitTest(scene, shapeId, rayOrigin, rayDir, edgeThreshold);
  }

  hitTestForSession(
    sessionId: string,
    shapeId: string,
    rayOrigin: [number, number, number],
    rayDir: [number, number, number],
    edgeThreshold: number,
  ): any {
    if (!this.sceneManager) {
      return null;
    }
    const scene = this.previousScenes.get(sessionId);
    if (!scene) {
      return null;
    }
    return this.sceneManager.hitTest(scene, shapeId, rayOrigin, rayDir, edgeThreshold);
  }

  setCompileError(err: CompileError | null): void {
    this.compileError = err;
  }

  getCompileError(): CompileError | null {
    return this.compileError;
  }

  setParam(sessionId: string, label: string, value: any): void {
    sessionId = normalizePath(sessionId);
    if (!this.paramOverrides.has(sessionId)) {
      this.paramOverrides.set(sessionId, new Map());
    }
    this.paramOverrides.get(sessionId)!.set(label, value);
    this.lastRendered.delete(sessionId);
  }

  resetParams(sessionId: string): void {
    sessionId = normalizePath(sessionId);
    this.paramOverrides.delete(sessionId);
    this.lastRendered.delete(sessionId);
  }

  /**
   * Follow a label rename in the source. Both the override and the baseline
   * it was set against are keyed by label, so without this the renamed param
   * would come back at its declared default while a ghost entry kept holding
   * the value under the old name. Only ever called after the source edit
   * landed, and that edit refuses a rename onto a label the file already
   * declares — so anything sitting under `to` here belongs to a param that no
   * longer exists.
   */
  renameParam(sessionId: string, from: string, to: string): void {
    sessionId = normalizePath(sessionId);
    FluidCadServer.moveKey(this.paramOverrides.get(sessionId), from, to);
    FluidCadServer.moveKey(this.lastParamDefaults.get(sessionId), from, to);
    this.lastRendered.delete(sessionId);
  }

  /** Forget a deleted param's override and the baseline behind it. */
  forgetParam(sessionId: string, label: string): void {
    sessionId = normalizePath(sessionId);
    const overrides = this.paramOverrides.get(sessionId);
    overrides?.delete(label);
    if (overrides?.size === 0) {
      this.paramOverrides.delete(sessionId);
    }
    this.lastParamDefaults.get(sessionId)?.delete(label);
    this.lastRendered.delete(sessionId);
  }

  private static moveKey<T>(map: Map<string, T> | undefined, from: string, to: string): void {
    if (!map || !map.has(from)) {
      return;
    }
    map.set(to, map.get(from)!);
    map.delete(from);
  }

  getParamOverrides(sessionId: string): Record<string, any> {
    const map = this.paramOverrides.get(normalizePath(sessionId));
    if (!map) return {};
    return Object.fromEntries(map);
  }

  getCurrentFileName(): string {
    return this.currentFileName;
  }

  /**
   * Test-only seam: stage a scene under the given file name so the inspection
   * accessors can read it without running the vite pipeline. Production code
   * never calls this — `processFile` populates the same map.
   */
  _setSceneForTesting(fileName: string, scene: any, rollbackStop: number = -1): void {
    this.currentFileName = fileName;
    this.previousScenes.set(fileName, scene);
    this.lastRollbackStop = rollbackStop;
  }

  /**
   * Pull the per-object build failures out of a render result.
   *
   * A feature whose `build()` throws does NOT abort the render: the renderer
   * catches it, records the message on that object, and carries on with the
   * rest of the scene. So "the render resolved" says nothing about whether the
   * model is right — every caller that reports a render outcome has to fold
   * these in, or it reports success over a scene that is missing features.
   */
  static collectObjectErrors(result: any[]): ObjectBuildError[] {
    const errors: ObjectBuildError[] = [];
    for (let index = 0; index < result.length; index++) {
      const obj = result[index];
      if (!obj?.hasError) {
        continue;
      }
      errors.push({
        index,
        id: obj.id,
        name: obj.name,
        uniqueKind: obj.uniqueType,
        message: obj.errorMessage || 'Build failed.',
        sourceLocation: obj.sourceLocation,
      });
    }
    return errors;
  }

  getSceneSummary(): SceneSummary | null {
    if (!this.currentFileName) {
      return null;
    }
    const scene = this.previousScenes.get(this.currentFileName);
    if (!scene) {
      return null;
    }
    const rendered = scene.getRenderedObjects() as any[];
    const objects: SceneSummaryObject[] = rendered.map((r, index) => ({
      index,
      id: r.id,
      kind: r.type,
      uniqueKind: r.uniqueType,
      name: r.name,
      params: sanitizeParams(r.object),
      sourceLocation: r.sourceLocation,
      shapeIds: ((r.sceneShapes ?? []) as any[]).map((s) => s.shapeId),
      fromCache: !!r.fromCache,
      hasError: !!r.hasError,
      errorMessage: r.errorMessage,
      containerId: r.parentId ?? null,
      isContainer: !!r.isContainer,
      visible: r.visible !== false,
    }));
    return {
      schemaVersion: 1,
      file: this.currentFileName,
      objects,
      rollbackStop: this.lastRollbackStop,
      compileError: this.compileError,
    };
  }

  getShapesList(): ShapeList | null {
    if (!this.currentFileName) {
      return null;
    }
    const scene = this.previousScenes.get(this.currentFileName);
    if (!scene) {
      return null;
    }
    const rendered = scene.getRenderedObjects() as any[];
    const shapes: ShapeListEntry[] = [];
    for (const r of rendered) {
      const sceneShapes = (r.sceneShapes ?? []) as any[];
      for (const s of sceneShapes) {
        shapes.push({
          shapeId: s.shapeId,
          type: s.shapeType,
          sceneObjectId: r.id,
        });
      }
    }
    return { shapes };
  }

  /**
   * Compose a stable cache key over the rendering inputs: the source bytes
   * being rendered plus the param overrides currently in effect for the
   * session. Param changes flip the hash so cached entries don't shadow a
   * recompute, even when the code text is byte-identical.
   */
  private computeParamsHash(sessionId: string, codeOrBundle: string): string {
    const overrides = this.paramOverrides.get(sessionId);
    const sortedEntries = overrides ? [...overrides.entries()].sort(([a], [b]) => a.localeCompare(b)) : [];
    const normalized = codeOrBundle.replace(/\r\n/g, '\n');
    return createHash('sha1')
      .update(normalized)
      .update('\0')
      .update(JSON.stringify(sortedEntries))
      .digest('hex');
  }
}

const MAX_PARAM_DEPTH = 6;

function sanitizeParams(value: unknown, depth = 0): any {
  if (value === null || value === undefined) {
    return value ?? null;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (depth >= MAX_PARAM_DEPTH) {
    return null;
  }
  if (Array.isArray(value)) {
    return value.map((v) => sanitizeParams(v, depth + 1));
  }
  if (typeof value === 'object') {
    // A scene-object reference. Render as { ref: id } so the agent can chase
    // it through other tools without us shipping the whole subtree.
    const maybeId = (value as any).id;
    const isSceneObjectRef =
      typeof maybeId === 'string' &&
      typeof (value as any).getType === 'function';
    if (isSceneObjectRef) {
      return { ref: maybeId };
    }
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v === 'function') {
        continue;
      }
      out[k] = sanitizeParams(v, depth + 1);
    }
    return out;
  }
  return null;
}

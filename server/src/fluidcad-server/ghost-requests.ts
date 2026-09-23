// Feature ghost (live preview) requests, their geometry references, and the sketch-region preview contracts.

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
  | Copy2DGhostRequest
  | Mirror2DGhostRequest;

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
  /**
   * The dialog's `.region()` picks — the keys of the regions to build. Absent
   * builds every region; an empty list is the bare `.region()`, which builds
   * nothing.
   */
  regions?: (string | number)[];
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
  /**
   * The dialog's `.region()` picks — the keys of the regions to build. Absent
   * builds every region; an empty list is the bare `.region()`, which builds
   * nothing.
   */
  regions?: (string | number)[];
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
  /** `.extend('start', …)` lead-in before the path, or null. */
  extendStart?: number | null;
  /** `.extend('end', …)` run-out past the path, or null. */
  extendEnd?: number | null;
  /**
   * The dialog's `.region()` picks — the keys of the regions to build. Absent
   * builds every region; an empty list is the bare `.region()`, which builds
   * nothing.
   */
  regions?: (string | number)[];
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
  /** World-space points, one per profile in each connection. */
  connections?: [number, number, number][][];
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
  /** The axes the rotations turn around: the plane's own, or the world's. */
  rotationAxes: 'local' | 'world';
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
 * The 2D copy dialog's direction slot on the wire: a sketch-plane axis from
 * the Sketch X / Sketch Y quick buttons (`xAxis()`), or a picked sketch line
 * the apply writes as `axis(<var>)`. A top-level `axis()` statement never
 * appears here, and "keep the current axis" only travels once it reads back
 * as a datum form.
 */
export type GhostSketchAxisRef =
  | { kind: 'local'; axis: 'x' | 'y' }
  | { kind: 'edge'; shapeId: string };

/**
 * The in-sketch mirror — keyed `mirror2d` on the wire because plain `mirror`
 * already names the 3D body-reflecting ghost. Like the 2D copy it builds
 * nothing: the reflection is its targets' own curves through one mirror
 * matrix, stamped once. Targets travel as on every sketch-op path (1 shapeId
 * = 1 sketch edge), each pick standing for its whole producing primitive; an
 * empty list is the target-less form, which mirrors the whole active sketch.
 */
export type Mirror2DGhostRequest = {
  feature: 'mirror2d';
  /** The picked sketch edges; empty mirrors the whole active sketch. */
  entities: { shapeId: string }[];
  /** The line to reflect across. */
  axis: GhostSketchAxisRef;
};

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
  /** Loft side-edge polylines, packed xyz. */
  matchLines?: number[][];
  plane?: { normal: { x: number; y: number; z: number }; center: { x: number; y: number; z: number } };
};

/**
 * A ghost outcome plus the status the route should answer with. `solids`
 * present is the success case; otherwise `reason` says why, and a refusal the
 * dialog hits while simply typing (a superseded request, a profile not in the
 * scene yet) stays a 200 the client silently clears on rather than an error.
 */
/** The region picker's request: a profile by call site and the dialog's current picks. */
export type SketchRegionsRequest = {
  profile: { filePath: string; line: number };
  keys: (string | number)[];
};

/** One region of the profile as the picker draws it — see lib `SketchRegionPreview`. */
export type SketchRegionPreview = {
  key: string;
  index: number;
  selected: boolean;
  meshes: any[];
};

export type SketchRegionsOutcome = {
  status: number;
  regions?: SketchRegionPreview[];
  reason?: string;
};

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

import type { VariableInfo } from './ui/expression-input';
import type { SourceLocation } from './types';

export type { SourceLocation };

type SourceLocationParam = { filePath?: string; line: number; column: number };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FaceProperties = {
  surfaceType: 'plane' | 'circle' | 'cylinder' | 'sphere' | 'torus' | 'cone' | 'other';
  areaMm2?: number;
  radius?: number;
  majorRadius?: number;
  minorRadius?: number;
  halfAngleDeg?: number;
};

export type EdgeProperties = {
  curveType: 'line' | 'circle' | 'arc' | 'ellipse' | 'other';
  length?: number;
  radius?: number;
  majorRadius?: number;
  minorRadius?: number;
};

export type Material = { name: string; density: number; densityUnit: string };

export type ShapeProperties = {
  volumeMm3: number;
  surfaceAreaMm2: number;
  centroid: { x: number; y: number; z: number };
};

export type ImportResult = { success: boolean; fileName?: string; error?: string };

export type MeasureVec = { x: number; y: number; z: number };

export type MeasureDistanceValue = {
  value: number;
  from: MeasureVec;
  to: MeasureVec;
};

export type MeasureEntityRef = {
  shapeId: string;
  kind: 'face' | 'edge';
  index: number;
};

export type MeasureEntityInfo = {
  ref: MeasureEntityRef;
  geomType: string;
  area?: number;
  length?: number;
  radius?: number;
};

export type MeasurePrimaryKey =
  | 'parallelDist'
  | 'centerDist'
  | 'axisDist'
  | 'minDist'
  | 'angle'
  | 'totalArea'
  | 'totalLength';

export type MeasureResult = {
  entities: MeasureEntityInfo[];
  primary: MeasurePrimaryKey;
  primaryLabel: string;
  minDist?: MeasureDistanceValue;
  maxDist?: MeasureDistanceValue;
  parallelDist?: MeasureDistanceValue;
  centerDist?: MeasureDistanceValue;
  axisDist?: MeasureDistanceValue;
  angleDeg?: number;
  angleLabel?: string;
  totalArea?: number;
  totalLength?: number;
};

export interface UserPreferences {
  theme: string;
  showGrid: boolean;
  cameraMode: 'perspective' | 'orthographic';
  showBuildTimings: boolean;
  measureLengthUnit?: 'mm' | 'cm' | 'm' | 'in';
  measureAngleUnit?: 'deg' | 'rad';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const JSON_HEADERS = { 'Content-Type': 'application/json' };

function postFireAndForget(url: string, body?: unknown): void {
  fetch(url, {
    method: 'POST',
    headers: body !== undefined ? JSON_HEADERS : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }).catch((err) => console.error(`POST ${url} failed:`, err));
}

async function postJson<T>(url: string, body: unknown, signal?: AbortSignal): Promise<T | null> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      return null;
    }
    return (await res.json()) as T;
  } catch (err: any) {
    if (err?.name !== 'AbortError') {
      console.error(`POST ${url} failed:`, err);
    }
    return null;
  }
}

async function getJson<T>(
  url: string,
  params?: Record<string, string | number>,
  signal?: AbortSignal,
): Promise<T | null> {
  try {
    let fullUrl = url;
    if (params) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        qs.set(k, String(v));
      }
      fullUrl += '?' + qs.toString();
    }
    const res = await fetch(fullUrl, { signal });
    if (!res.ok) {
      return null;
    }
    return (await res.json()) as T;
  } catch (err: any) {
    if (err?.name !== 'AbortError') {
      console.error(`GET ${url} failed:`, err);
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Sketch interaction (fire-and-forget)
// ---------------------------------------------------------------------------

export function insertPoint(point: [number, number], sourceLocation: SourceLocationParam): void {
  postFireAndForget('/api/insert-point', { point, sourceLocation });
}

export function setPickPoints(points: [number, number][], sourceLocation: SourceLocationParam): void {
  postFireAndForget('/api/set-pick-points', { points, sourceLocation });
}

export function addPick(sourceLocation: SourceLocationParam): void {
  postFireAndForget('/api/add-pick', { sourceLocation });
}

export function removePick(sourceLocation: SourceLocationParam): void {
  postFireAndForget('/api/remove-pick', { sourceLocation });
}

export function insertGeometry(
  statement: string,
  sketchSourceLocation: SourceLocationParam,
  newVariable?: { name: string; initializer: string } | null,
): void {
  postFireAndForget('/api/insert-geometry', {
    statement,
    sketchSourceLocation,
    newVariable: newVariable ?? null,
  });
}


// ---------------------------------------------------------------------------
// Drag / position updates (fire-and-forget)
// ---------------------------------------------------------------------------

export function setLinePosition(
  newStart: [number, number],
  newEnd: [number, number],
  sourceLocation: SourceLocationParam,
): void {
  postFireAndForget('/api/set-line-position', { newStart, newEnd, sourceLocation });
}

export function updatePosition(
  newPosition: [number, number],
  sourceLocation: SourceLocationParam,
  pointIndex?: number,
): void {
  postFireAndForget('/api/update-position', { newPosition, sourceLocation, pointIndex });
}

export function setChainPositions(
  updates: { pointIndex: number; position: [number, number] }[],
  sourceLocation: SourceLocationParam,
): void {
  postFireAndForget('/api/set-chain-positions', { updates, sourceLocation });
}

export function setRectDimensions(
  width: number,
  height: number,
  sourceLocation: SourceLocationParam,
  startPoint?: [number, number],
): void {
  postFireAndForget('/api/set-rect-dimensions', { width, height, sourceLocation, startPoint: startPoint ?? null });
}

export function updateDimensionExpression(
  expression: string,
  sourceLocation: SourceLocationParam,
  sketchSourceLine: number | null,
  newVariable?: { name: string; initializer: string } | null,
  dimensionOffset?: number,
): void {
  postFireAndForget('/api/update-dimension-expression', {
    expression,
    sourceLocation,
    sketchSourceLine,
    newVariable: newVariable ?? null,
    dimensionOffset: dimensionOffset ?? 0,
  });
}

// ---------------------------------------------------------------------------
// Queries (async with response)
// ---------------------------------------------------------------------------

export async function getDimensionExpression(
  sourceLine: number,
): Promise<{ expression: string | null }> {
  return (await postJson('/api/dimension-expression', { sourceLine })) ?? { expression: null };
}

export async function getScopeVariables(
  sketchSourceLine: number,
): Promise<VariableInfo[]> {
  const data = await postJson<{ variables: VariableInfo[] }>(
    '/api/scope-variables',
    { sketchSourceLine },
  );
  return data?.variables ?? [];
}

export function getFaceProperties(
  shapeId: string,
  faceIndex: number,
  signal?: AbortSignal,
): Promise<FaceProperties | null> {
  return getJson('/api/face-properties', { shapeId, faceIndex }, signal);
}

export function getEdgeProperties(
  shapeId: string,
  edgeIndex: number,
  signal?: AbortSignal,
): Promise<EdgeProperties | null> {
  return getJson('/api/edge-properties', { shapeId, edgeIndex }, signal);
}

export function getShapeProperties(shapeId: string): Promise<ShapeProperties | null> {
  return getJson('/api/shape-properties', { shapeId });
}

export function measureEntities(
  entities: MeasureEntityRef[],
  signal?: AbortSignal,
): Promise<MeasureResult | null> {
  return postJson('/api/measure', { entities }, signal);
}

// ---------------------------------------------------------------------------
// Select → apply feature
// ---------------------------------------------------------------------------

export type ApplyFeatureEntity = {
  shapeId: string;
  sub: { type: 'edge' | 'face'; index: number };
};

/** A tangent chain: the right-clicked pick plus its full expansion. */
export type ApplyFeatureChain = {
  seed: ApplyFeatureEntity;
  members: ApplyFeatureEntity[];
};

export type ApplyFeatureResponse = {
  success: boolean;
  preview?: string;
  /** The selector argument list alone (preview requests). */
  args?: string;
  /** Verified alternative renderings of the argument list (preview requests). */
  alternatives?: string[];
  reason?: string;
};

/** How a shell's inner-wall offset closes corners; 'arc' is the default. */
export type ShellJoinType = 'arc' | 'intersection' | 'tangent';

export type ApplyFeatureOptions = {
  chains?: ApplyFeatureChain[];
  /** User-edited argument list; replaces the synthesized selectors verbatim. */
  selectorOverride?: string;
  /**
   * Pick-less sketch only (empty `entities`): the origin plane the statement
   * targets — `sketch('<plane>', () => {})`.
   */
  plane?: 'xy' | 'xz' | 'yz';
  /** Shell only: writes a `.join('<type>')` chain; 'arc' writes none. */
  joinType?: ShellJoinType;
  /** Synthesize only — return the expression preview without applying. */
  preview?: boolean;
  signal?: AbortSignal;
};

/**
 * Ask the server to synthesize (and, unless `preview` is set, apply) a
 * feature for the picked entities. `value` is the numeric parameter
 * (radius/distance/thickness); pass null for sketch, which has none. Unlike
 * `postJson`, failure bodies are surfaced — a 422 carries the human-readable
 * reason the selection couldn't be expressed as code.
 */
export async function applyFeature(
  feature: 'fillet' | 'chamfer' | 'shell' | 'sketch',
  value: number | null,
  entities: ApplyFeatureEntity[],
  options: ApplyFeatureOptions = {},
): Promise<ApplyFeatureResponse> {
  return postApplyFeature({
    feature,
    value: value ?? undefined,
    entities,
    chains: options.chains,
    selectorOverride: options.selectorOverride,
    plane: options.plane,
    joinType: options.joinType,
    preview: options.preview,
  }, options.signal);
}

/** The profile sketch an extrude consumes, addressed by its source location. */
export type ExtrudeProfileRef = {
  /** `active` consumes the sketch implicitly; `bound` binds it to a variable. */
  mode: 'active' | 'bound';
  filePath: string;
  line: number;
  column: number;
};

/** The extrude options the dialog edits, shared by create and edit applies. */
export type ExtrudeOptionValues = {
  op: 'add' | 'remove' | 'new';
  /** Extrusion distance; null is a through-all remove. */
  distance: number | null;
  /** Second (opposite-direction) distance — `extrude(d1, d2)`; excludes symmetric. */
  distance2: number | null;
  /** `.symmetric()` — the distance splits equally across the sketch plane. */
  symmetric: boolean;
  /** `.draft(angle)` taper in degrees, or null for a straight extrude. */
  draft: number | null;
  /** False writes `.drill(false)` — inner closed regions extrude as solid. */
  drill: boolean;
  /** `.thin()` offsets, or null for a plain extrude. */
  thin: [number] | [number, number] | null;
};

export type ExtrudeApplyOptions = ExtrudeOptionValues & {
  profile: ExtrudeProfileRef;
  /** Up-to-face target: a picked face replacing the distance(s). */
  toFace?: ApplyFeatureEntity;
  /** Render the statement preview without applying. */
  preview?: boolean;
  signal?: AbortSignal;
};

/**
 * Ask the server to write (or, with `preview`, just render) an extrude/cut
 * statement consuming a sketch profile. Same endpoint and response shape as
 * {@link applyFeature}; the only pick involved is the optional up-to-face
 * target, synthesized into a face selector server-side.
 */
export async function applyExtrude(options: ExtrudeApplyOptions): Promise<ApplyFeatureResponse> {
  return postApplyFeature({
    feature: 'extrude',
    op: options.op,
    distance: options.distance,
    distance2: options.distance2,
    symmetric: options.symmetric,
    draft: options.draft,
    drill: options.drill,
    thin: options.thin,
    profile: options.profile,
    toFace: options.toFace,
    preview: options.preview,
  }, options.signal);
}

/** A sketch input addressed by its rendered source location. */
export type SketchSourceRef = { filePath: string; line: number; column: number };

/** The revolve options the dialog edits, shared by create and edit applies. */
export type RevolveOptionValues = {
  op: 'add' | 'remove' | 'new';
  /** Sweep angle in degrees; 360 (the API default) writes no argument. */
  angle: number;
  /** `.thin()` offsets, or null for a plain revolve. */
  thin: [number] | [number, number] | null;
};

/**
 * The revolve axis: a standard world axis, an existing `axis(…)` statement
 * addressed by its source location, or a picked edge — synthesized into
 * `axis(<edge selector>)` server-side.
 */
export type RevolveAxisRef =
  | { kind: 'standard'; axis: 'x' | 'y' | 'z' }
  | ({ kind: 'axis' } & SketchSourceRef)
  | { kind: 'edge'; entity: ApplyFeatureEntity };

export type RevolveApplyOptions = RevolveOptionValues & {
  profile: ExtrudeProfileRef;
  axis: RevolveAxisRef;
  /** Render the statement preview without applying. */
  preview?: boolean;
  signal?: AbortSignal;
};

/**
 * Ask the server to write (or, with `preview`, just render) a revolve
 * statement sweeping a sketch profile around an axis. Same endpoint and
 * response shape as {@link applyFeature}.
 */
export async function applyRevolve(options: RevolveApplyOptions): Promise<ApplyFeatureResponse> {
  return postApplyFeature({
    feature: 'revolve',
    op: options.op,
    angle: options.angle,
    thin: options.thin,
    profile: options.profile,
    axis: options.axis,
    preview: options.preview,
  }, options.signal);
}

export type SweepApplyOptions = {
  op: 'add' | 'remove' | 'new';
  /** `.thin()` offsets, or null for a plain sweep. */
  thin: [number] | [number, number] | null;
  profile: ExtrudeProfileRef;
  /** The path: another sketch, or picked edges to synthesize a selector from. */
  path:
    | ({ kind: 'sketch' } & SketchSourceRef)
    | { kind: 'edges'; entities: ApplyFeatureEntity[]; chains?: ApplyFeatureChain[] };
  /** Render the statement preview without applying. */
  preview?: boolean;
  signal?: AbortSignal;
};

/**
 * Ask the server to write (or, with `preview`, just render) a sweep statement
 * consuming a sketch profile along a path. Same endpoint and response shape
 * as {@link applyFeature}.
 */
export async function applySweep(options: SweepApplyOptions): Promise<ApplyFeatureResponse> {
  return postApplyFeature({
    feature: 'sweep',
    op: options.op,
    thin: options.thin,
    profile: options.profile,
    path: options.path,
    preview: options.preview,
  }, options.signal);
}

/** One ordered loft profile: a sketch, or a face picked in the 3D view. */
export type LoftProfileRef =
  | ({ kind: 'sketch' } & SketchSourceRef)
  | { kind: 'face'; entity: ApplyFeatureEntity };

/** A `.startCondition()`/`.endCondition()` takeoff constraint; null = none. */
export type LoftConditionRef = { type: 'normal' | 'tangent'; magnitude: number };

export type LoftApplyOptions = {
  op: 'add' | 'remove' | 'new';
  /** `.thin()` offsets, or null for a plain loft. */
  thin: [number] | [number, number] | null;
  /** Ordered profiles — the loft's argument order. */
  profiles: LoftProfileRef[];
  /** Up to two guide-curve sketches (`.guides(…)`); excludes thin mode. */
  guides: SketchSourceRef[];
  startCondition: LoftConditionRef | null;
  endCondition: LoftConditionRef | null;
  /** Render the statement preview without applying. */
  preview?: boolean;
  signal?: AbortSignal;
};

/**
 * Ask the server to write (or, with `preview`, just render) a loft statement
 * over the ordered profiles. Same endpoint and response shape as
 * {@link applyFeature}.
 */
export async function applyLoft(options: LoftApplyOptions): Promise<ApplyFeatureResponse> {
  return postApplyFeature({
    feature: 'loft',
    op: options.op,
    thin: options.thin,
    profiles: options.profiles,
    guides: options.guides,
    startCondition: options.startCondition,
    endCondition: options.endCondition,
    preview: options.preview,
  }, options.signal);
}

/**
 * One base of a plane request: a standard origin plane, a face/edge picked in
 * the 3D view, or an existing plane feature addressed by its source location.
 */
export type PlaneBaseRef =
  | { kind: 'standard'; plane: 'xy' | 'xz' | 'yz' }
  | { kind: 'pick'; entity: ApplyFeatureEntity }
  | ({ kind: 'plane' } & SketchSourceRef);

export type PlaneApplyOptions = {
  /** `offset`/`edge` take one base; `mid` takes two. */
  type: 'offset' | 'mid' | 'edge';
  /** Normal offset distance; null renders none. Offset type only. */
  offset: number | null;
  /** Rotation in degrees around the plane's local axes; null renders none. */
  rotateX: number | null;
  rotateY: number | null;
  rotateZ: number | null;
  /** Normalized 0–1 position along the edge (edge type only). */
  position: number | null;
  bases: PlaneBaseRef[];
  /** Render the statement preview without applying. */
  preview?: boolean;
  signal?: AbortSignal;
};

/**
 * Ask the server to write (or, with `preview`, just render) a plane statement
 * over the base(s). Same endpoint and response shape as {@link applyFeature}.
 */
export async function applyPlane(options: PlaneApplyOptions): Promise<ApplyFeatureResponse> {
  return postApplyFeature({
    feature: 'plane',
    type: options.type,
    offset: options.offset,
    rotateX: options.rotateX,
    rotateY: options.rotateY,
    rotateZ: options.rotateZ,
    position: options.position,
    bases: options.bases,
    preview: options.preview,
  }, options.signal);
}

// ---------------------------------------------------------------------------
// Feature statement editing (timeline double-click → edit dialog)
// ---------------------------------------------------------------------------

/** The statement a double-clicked timeline row edits, by source location. */
export type FeatureEditTarget = SketchSourceRef;

/**
 * The edited statement as a selection boundary: its timeline row plus its
 * call site. Selection queries carrying one resolve against the scene
 * objects strictly before it — the world that statement's arguments see at
 * build time. The server validates the row still holds that call site and
 * refuses stale ones.
 */
export type SelectionBoundaryRef = {
  index: number;
  type: string;
  line: number;
  column: number;
};

/**
 * One source slot of the edited statement, resolved for dialog seeding: a
 * sketch input by call site, a selection input as pick entities on the
 * pre-statement solids, or `opaque` — real but not representable as picks
 * (inline sketches, clones, loop call sites, to-face targets), so the dialog
 * keeps that slot's verbatim text.
 */
export type SourceSlotRef =
  | { kind: 'sketch'; filePath: string; line: number; column: number }
  | { kind: 'entities'; entities: ApplyFeatureEntity[] }
  | { kind: 'opaque' };

export type FeatureSourcesResult =
  | { ok: true; feature: 'extrude' | 'cut'; profile: SourceSlotRef; toFace?: SourceSlotRef }
  | { ok: true; feature: 'sweep'; profile: SourceSlotRef; path: SourceSlotRef }
  | { ok: true; feature: 'loft'; profiles: SourceSlotRef[]; guides: SourceSlotRef[] }
  | { ok: true; feature: 'revolve'; profile: SourceSlotRef; axis: SourceSlotRef }
  | { ok: true; feature: 'shell' | 'fillet' | 'chamfer'; selection: SourceSlotRef }
  | { ok: false; reason: string };

/** Current sources of the statement at `before`, for edit-dialog seeding. */
export async function fetchFeatureSources(before: SelectionBoundaryRef): Promise<FeatureSourcesResult> {
  try {
    const res = await fetch('/api/feature/sources', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ before }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || body?.ok !== true) {
      return { ok: false, reason: body?.error ?? `Request failed (${res.status})` };
    }
    return body;
  } catch {
    return { ok: false, reason: 'Could not reach the FluidCAD server' };
  }
}

export type FeatureOpKind = 'add' | 'remove' | 'new';

/**
 * An existing statement's dialog-editable reading (mirror of the server's
 * `ParsedFeatureStatement`). Expressions the dialogs don't edit (profiles,
 * paths, selector args) arrive as verbatim source text.
 */
export type ParsedFeatureStatement =
  | {
      feature: 'extrude';
      op: FeatureOpKind;
      distance: number | null;
      distance2: number | null;
      symmetric: boolean;
      draft: number | null;
      drill: boolean;
      thin: [number] | null;
      profileText: string | null;
      /** Up-to-face target argument text, or null for a distance extrude. */
      toFaceText: string | null;
    }
  | {
      feature: 'sweep';
      op: FeatureOpKind;
      thin: [number] | null;
      pathText: string;
      profileText: string | null;
    }
  | {
      feature: 'revolve';
      op: FeatureOpKind;
      /** Sweep angle in degrees; null = omitted (the 360° API default). */
      angle: number | null;
      thin: [number] | null;
      /** Axis argument text, verbatim (`'z'`, `a`, `axis(e.edges(3))`). */
      axisText: string;
      profileText: string | null;
    }
  | {
      feature: 'loft';
      op: FeatureOpKind;
      thin: [number] | null;
      profileTexts: string[];
      guideTexts: string[];
      startCondition: LoftConditionRef | null;
      endCondition: LoftConditionRef | null;
    }
  | {
      feature: 'shell';
      value: number;
      argsText: string;
      /** `.join()` type; 'arc' (the kernel default) when the chain is absent. */
      joinType: ShellJoinType;
    }
  | { feature: 'fillet' | 'chamfer'; value: number; argsText: string };

export type ParseFeatureResult =
  | { ok: true; parsed: ParsedFeatureStatement; statement: string }
  | { ok: false; reason: string };

/**
 * Read the feature statement at a timeline row's source location into its
 * dialog-editable options. A refusal (`ok: false`) carries the reason the
 * statement can't be edited in a dialog.
 */
export async function parseFeatureAt(target: { filePath: string; line: number }): Promise<ParseFeatureResult> {
  try {
    const res = await fetch('/api/feature/parse', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ filePath: target.filePath, line: target.line }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || body?.ok !== true) {
      return { ok: false, reason: body?.error ?? `Request failed (${res.status})` };
    }
    return { ok: true, parsed: body.parsed, statement: body.statement };
  } catch {
    return { ok: false, reason: 'Could not reach the FluidCAD server' };
  }
}

/**
 * Session fields every edit apply carries: the statement text captured at
 * dialog-open (the transform refuses when the code drifted under the
 * session) and the boundary re-picked geometry resolves against.
 */
export type EditSessionFields = {
  expectedStatement?: string;
  before?: SelectionBoundaryRef;
};

export type ExtrudeEditOptions = ExtrudeOptionValues & EditSessionFields & {
  /** Re-sourced profile sketch; omitted keeps the statement's own. */
  profile?: { mode: 'bound' } & SketchSourceRef;
  /**
   * Up-to-face target: `keep` re-emits the statement's own target text,
   * `face` re-picks it. Omitted writes the distance form (dropping any
   * target the statement had).
   */
  toFace?: { kind: 'keep' } | { kind: 'face'; entity: ApplyFeatureEntity };
  preview?: boolean;
  signal?: AbortSignal;
};

/** Rewrite the extrude/cut statement at `edit` in place. */
export async function applyExtrudeEdit(
  edit: FeatureEditTarget,
  options: ExtrudeEditOptions,
): Promise<ApplyFeatureResponse> {
  return postApplyFeature({
    feature: 'extrude',
    edit,
    expectedStatement: options.expectedStatement,
    before: options.before,
    op: options.op,
    distance: options.distance,
    distance2: options.distance2,
    symmetric: options.symmetric,
    draft: options.draft,
    drill: options.drill,
    thin: options.thin,
    profile: options.profile,
    toFace: options.toFace,
    preview: options.preview,
  }, options.signal);
}

export type SweepEditOptions = EditSessionFields & {
  op: FeatureOpKind;
  thin: [number] | [number, number] | null;
  /** Re-sourced path; omitted keeps the statement's own. */
  path?: ({ kind: 'sketch' } & SketchSourceRef)
    | { kind: 'edges'; entities: ApplyFeatureEntity[]; chains: ApplyFeatureChain[] };
  /** Re-sourced profile sketch; omitted keeps the statement's own. */
  profile?: { kind: 'sketch' } & SketchSourceRef;
  preview?: boolean;
  signal?: AbortSignal;
};

/** Rewrite the sweep statement at `edit` in place. */
export async function applySweepEdit(
  edit: FeatureEditTarget,
  options: SweepEditOptions,
): Promise<ApplyFeatureResponse> {
  return postApplyFeature({
    feature: 'sweep',
    edit,
    expectedStatement: options.expectedStatement,
    before: options.before,
    op: options.op,
    thin: options.thin,
    path: options.path,
    profile: options.profile,
    preview: options.preview,
  }, options.signal);
}

export type RevolveEditOptions = RevolveOptionValues & EditSessionFields & {
  /** Re-sourced profile sketch; omitted keeps the statement's own. */
  profile?: { mode: 'bound' } & SketchSourceRef;
  /** Re-sourced axis; omitted keeps the statement's own. */
  axis?: RevolveAxisRef;
  preview?: boolean;
  signal?: AbortSignal;
};

/** Rewrite the revolve statement at `edit` in place. */
export async function applyRevolveEdit(
  edit: FeatureEditTarget,
  options: RevolveEditOptions,
): Promise<ApplyFeatureResponse> {
  return postApplyFeature({
    feature: 'revolve',
    edit,
    expectedStatement: options.expectedStatement,
    before: options.before,
    op: options.op,
    angle: options.angle,
    thin: options.thin,
    profile: options.profile,
    axis: options.axis,
    preview: options.preview,
  }, options.signal);
}

/** One profile of an edited loft, in argument order. */
export type LoftEditProfileRef =
  | { kind: 'verbatim'; sourceIndex: number }
  | ({ kind: 'sketch' } & SketchSourceRef)
  | { kind: 'face'; entity: ApplyFeatureEntity };

/** One guide of an edited loft — like profiles, but never a face. */
export type LoftEditGuideRef =
  | { kind: 'verbatim'; sourceIndex: number }
  | ({ kind: 'sketch' } & SketchSourceRef);

export type LoftEditOptions = EditSessionFields & {
  op: FeatureOpKind;
  thin: [number] | [number, number] | null;
  startCondition: LoftConditionRef | null;
  endCondition: LoftConditionRef | null;
  /** Full replacement profile list; omitted keeps the statement's own. */
  profiles?: LoftEditProfileRef[];
  /** Full replacement guide list; omitted keeps the statement's own. */
  guides?: LoftEditGuideRef[];
  preview?: boolean;
  signal?: AbortSignal;
};

/** Rewrite the loft statement at `edit` in place. */
export async function applyLoftEdit(
  edit: FeatureEditTarget,
  options: LoftEditOptions,
): Promise<ApplyFeatureResponse> {
  return postApplyFeature({
    feature: 'loft',
    edit,
    expectedStatement: options.expectedStatement,
    before: options.before,
    op: options.op,
    thin: options.thin,
    startCondition: options.startCondition,
    endCondition: options.endCondition,
    profiles: options.profiles,
    guides: options.guides,
    preview: options.preview,
  }, options.signal);
}

export type ValueFeatureEditOptions = EditSessionFields & {
  value: number;
  /** Edited selector argument list; omitted keeps the statement's verbatim. */
  selectorOverride?: string;
  /** Shell only: rewrites the `.join('<type>')` chain; 'arc' writes none. */
  joinType?: ShellJoinType;
  /** Re-picked selection; omitted keeps the statement's own args. */
  entities?: ApplyFeatureEntity[];
  chains?: ApplyFeatureChain[];
  preview?: boolean;
  signal?: AbortSignal;
};

/** Rewrite the shell/fillet/chamfer statement at `edit` in place. */
export async function applyValueFeatureEdit(
  feature: 'shell' | 'fillet' | 'chamfer',
  edit: FeatureEditTarget,
  options: ValueFeatureEditOptions,
): Promise<ApplyFeatureResponse> {
  return postApplyFeature({
    feature,
    edit,
    expectedStatement: options.expectedStatement,
    before: options.before,
    value: options.value,
    selectorOverride: options.selectorOverride,
    joinType: options.joinType,
    entities: options.entities,
    chains: options.chains,
    preview: options.preview,
  }, options.signal);
}

/**
 * Variable names of the sketch (or plane) statements at the given source
 * lines (dialog labels). Unbound or unresolvable lines come back null;
 * failures degrade to all-null — the labels are cosmetic.
 */
export async function fetchSketchNames(
  lines: number[],
  callee: 'sketch' | 'plane' | 'axis' = 'sketch',
): Promise<(string | null)[]> {
  try {
    const res = await fetch('/api/sketch-names', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ lines, callee }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || !Array.isArray(body?.names)) {
      return lines.map(() => null);
    }
    return body.names;
  } catch {
    return lines.map(() => null);
  }
}

/** Shared POST for /api/apply-feature: failure bodies surface their reason. */
async function postApplyFeature(
  payload: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<ApplyFeatureResponse> {
  try {
    const res = await fetch('/api/apply-feature', {
      method: 'POST',
      headers: JSON_HEADERS,
      signal,
      body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      return { success: false, reason: body?.reason ?? body?.error ?? `Request failed (${res.status})` };
    }
    return body ?? { success: false, reason: 'Empty server response' };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw err;
    }
    return { success: false, reason: 'Could not reach the FluidCAD server' };
  }
}

/** `sibling` = the producing feature's other classified buckets ("Select other"). */
export type SelectionGroupKind = 'tangent' | 'classified' | 'same-type' | 'equal' | 'sibling';

/** One right-click multi-select option: what it's called and what it selects. */
export type SelectionGroup = {
  kind: SelectionGroupKind;
  label: string;
  members: ApplyFeatureEntity[];
};

/** Expand a picked edge/face to its tangent chain on the owning solid. */
export async function expandTangents(
  entity: ApplyFeatureEntity,
  before?: SelectionBoundaryRef,
): Promise<{ members: ApplyFeatureEntity[] } | { error: string }> {
  return selectionQuery('/api/selection/expand-tangents', entity, before);
}

/** Expand a picked edge/face to its whole classified bucket. */
export async function expandBucket(
  entity: ApplyFeatureEntity,
  before?: SelectionBoundaryRef,
): Promise<{ members: ApplyFeatureEntity[] } | { error: string }> {
  return selectionQuery('/api/selection/expand-bucket', entity, before);
}

/** Every multi-select group a pick can expand to (the right-click menu). */
export async function fetchSelectionGroups(
  entity: ApplyFeatureEntity,
  before?: SelectionBoundaryRef,
): Promise<{ groups: SelectionGroup[] } | { error: string }> {
  return selectionQuery('/api/selection/groups', entity, before);
}

async function selectionQuery<T>(
  endpoint: string,
  entity: ApplyFeatureEntity,
  before?: SelectionBoundaryRef,
): Promise<T | { error: string }> {
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ entity, before }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      return { error: body?.error ?? `Request failed (${res.status})` };
    }
    return (body as T) ?? { error: 'Empty server response' };
  } catch {
    return { error: 'Could not reach the FluidCAD server' };
  }
}

export function explainSelection(
  entities: ApplyFeatureEntity[],
  signal?: AbortSignal,
  before?: SelectionBoundaryRef,
): Promise<{ picks: any[] } | null> {
  return postJson('/api/selection/explain', { entities, before }, signal);
}

export function getMaterials(): Promise<Material[] | null> {
  return getJson('/api/materials');
}

// ---------------------------------------------------------------------------
// Timeline actions (fire-and-forget)
// ---------------------------------------------------------------------------

export function recompute(): void {
  postFireAndForget('/api/recompute');
}

export function rollback(index: number): void {
  postFireAndForget('/api/rollback', { index });
}

export function addBreakpoint(sourceLocation: SourceLocationParam): void {
  postFireAndForget('/api/add-breakpoint', { sourceLocation });
}

export function clearBreakpoints(): void {
  postFireAndForget('/api/clear-breakpoints');
}

export function gotoSource(sourceLocation: SourceLocationParam): void {
  postFireAndForget('/api/code/goto-source', sourceLocation);
}

// ---------------------------------------------------------------------------
// File operations
// ---------------------------------------------------------------------------

export async function importFile(fileName: string, data: string): Promise<ImportResult> {
  return (
    (await postJson<ImportResult>('/api/import-file', { fileName, data })) ?? {
      success: false,
      error: 'Network error',
    }
  );
}

export async function exportShapes(body: Record<string, unknown>): Promise<Blob> {
  const res = await fetch('/api/export', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || 'Export failed');
  }
  return res.blob();
}

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

export async function loadPreferences(): Promise<UserPreferences | null> {
  return getJson('/api/preferences');
}

export function savePreference<K extends keyof UserPreferences>(
  key: K,
  value: UserPreferences[K],
): void {
  postFireAndForget('/api/preferences', { [key]: value });
}

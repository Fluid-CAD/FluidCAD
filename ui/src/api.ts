import type { VariableInfo } from './ui/expression-input';
import type { SceneObjectMesh, SourceLocation } from './types';

export type { SourceLocation };

/**
 * A dialog numeric slot on the wire: a plain number, or verbatim expression
 * text (`height`, `h * 2`) committed by an expression field. The server
 * renders expressions as-is into the statement.
 */
export type ValueExpr = number | string;

/** A `const <name> = <initializer>` declaration an expression field committed. */
export type NewVariable = { name: string; initializer: string };

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

/**
 * By-region trim: ask the server to synthesize edge-filter args for the
 * clicked region's boundary segments and write them into the trim() call at
 * the given location (`trim(edge().line(80)).pick()`). Resolves
 * `{ success: false, reason }` when no filter separates the boundary; the
 * region mode only ever writes filters, so a refusal surfaces to the user.
 */
export async function applyTrimRegion(
  edgeIds: string[],
  sourceLocation: SourceLocationParam,
): Promise<{ success: boolean; reason?: string }> {
  try {
    const res = await fetch('/api/apply-trim-region', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ edgeIds, sourceLocation }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      return { success: false, reason: body?.reason ?? body?.error ?? `Request failed (${res.status})` };
    }
    return body ?? { success: false, reason: 'Empty server response' };
  } catch {
    return { success: false, reason: 'Could not reach the FluidCAD server' };
  }
}

export function removePick(sourceLocation: SourceLocationParam): void {
  postFireAndForget('/api/remove-pick', { sourceLocation });
}

export function insertGeometry(
  statement: string,
  sketchSourceLocation: SourceLocationParam,
  newVariable?:
    | { name: string; initializer: string }
    | { name: string; initializer: string }[]
    | null,
): void {
  // A single declaration travels as a plain object, matching the original
  // wire shape; arrays are reserved for multi-variable commits.
  const normalized = Array.isArray(newVariable)
    ? (newVariable.length === 0 ? null : newVariable.length === 1 ? newVariable[0] : newVariable)
    : newVariable ?? null;
  postFireAndForget('/api/insert-geometry', {
    statement,
    sketchSourceLocation,
    newVariable: normalized,
  });
}


// ---------------------------------------------------------------------------
// Text tool (fonts + outline preview)
// ---------------------------------------------------------------------------

export type TextAlignOption = 'left' | 'center' | 'right';

/** The `text()` chain options the Text tool's dialog edits. */
export type TextOptionValues = {
  text: string;
  size: number;
  /** Font family display name; null renders no `.font()` (registry default). */
  font: string | null;
  weight: number;
  italic: boolean;
  align: TextAlignOption;
  lineSpacing: number;
  letterSpacing: number;
};

export type TextPreviewRequest = {
  text: string;
  /** Baseline start in sketch-plane 2D coordinates. */
  position: [number, number];
  plane: {
    origin: { x: number; y: number; z: number };
    normal: { x: number; y: number; z: number };
    xDirection: { x: number; y: number; z: number };
  };
  options: Omit<TextOptionValues, 'text'>;
};

/** Sorted system font family names, or [] when the lookup fails. */
export async function getFontFamilies(): Promise<string[]> {
  const data = await getJson<{ families: string[] }>('/api/fonts');
  return data?.families ?? [];
}

/**
 * World-space outline polylines (flat xyz runs) of the text laid out with
 * the given options — the Text tool's viewport preview. Null on failure.
 */
export async function getTextPreview(
  request: TextPreviewRequest,
  signal?: AbortSignal,
): Promise<{ polylines: number[][] } | null> {
  return postJson('/api/text-preview', request, signal);
}

// ---------------------------------------------------------------------------
// Live dialog geometry ("ghost")
// ---------------------------------------------------------------------------

/**
 * A live geometry request for the open feature dialog. "Ghost" throughout, to
 * keep it apart from the dialogs' statement-text *preview* — this is the
 * translucent body drawn in the viewport, not the source line in the panel.
 *
 * The profile is always an explicit source ref, so one request shape serves
 * the create dialog and the edit dialog alike: the client resolves "keep the
 * current profile" to the statement's own sketch before asking.
 */
export type FeatureGhostRequest = {
  feature: 'extrude';
  op: 'add' | 'remove' | 'new';
  /** Extrusion distance; null is a through-all cut (`remove` only). */
  distance: ValueExpr | null;
  distance2: ValueExpr | null;
  symmetric: boolean;
  draft: ValueExpr | null;
  drill: boolean;
  thin: [ValueExpr] | [ValueExpr, ValueExpr] | null;
  profile: { filePath: string; line: number };
};

/** One ghost body, in the mesh wire format the scene's solids already use. */
export type GhostSolid = { meshes: SceneObjectMesh[] };

/**
 * The bodies the dialog's current values would produce, meshed server-side.
 * Null whenever there is nothing to draw — an unresolvable expression, an
 * empty profile, a scene that moved on — so callers just clear the overlay.
 * An abort propagates, matching the statement-preview fetch.
 */
export async function fetchFeatureGhost(
  request: FeatureGhostRequest,
  signal: AbortSignal,
): Promise<GhostSolid[] | null> {
  try {
    const res = await fetch('/api/feature-ghost', {
      method: 'POST',
      headers: JSON_HEADERS,
      signal,
      body: JSON.stringify(request),
    });
    if (!res.ok) {
      return null;
    }
    const body = await res.json().catch(() => null);
    return body?.success === true ? body.solids ?? [] : null;
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw err;
    }
    return null;
  }
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
  dimensionCall?: string | null,
  dimensionInsert?: boolean,
  dimensionPoint?: [number, number] | null,
): void {
  postFireAndForget('/api/update-dimension-expression', {
    expression,
    sourceLocation,
    sketchSourceLine,
    newVariable: newVariable ?? null,
    dimensionOffset: dimensionOffset ?? 0,
    dimensionCall: dimensionCall ?? null,
    dimensionInsert: dimensionInsert ?? false,
    dimensionPoint: dimensionPoint ?? null,
  });
}

// ---------------------------------------------------------------------------
// Queries (async with response)
// ---------------------------------------------------------------------------

export async function getDimensionExpression(
  sourceLine: number,
  dimensionOffset?: number,
  dimensionCall?: string | null,
): Promise<{ expression: string | null }> {
  return (await postJson('/api/dimension-expression', {
    sourceLine,
    dimensionOffset: dimensionOffset ?? 0,
    dimensionCall: dimensionCall ?? null,
  })) ?? { expression: null };
}

/** Variables in scope at `sketchSourceLine`; null means whole-file scope
 * (the feature dialogs' create mode — statements append at the end). */
export async function getScopeVariables(
  sketchSourceLine: number | null,
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
  /**
   * Pick-less sketch only (empty `entities`): an existing `plane(…)` feature
   * the statement targets, by call site — `sketch(<planeVar>, () => {})`.
   * Mutually exclusive with `plane`.
   */
  planeRef?: SketchSourceRef;
  /**
   * Sketch only: rewrite the target argument of the sketch statement at this
   * location instead of appending a new one — the sketch dialog's re-pick
   * ("move the sketch"). The body callback is preserved verbatim.
   */
  retarget?: SketchSourceRef;
  /** Shell only: writes a `.join('<type>')` chain; 'arc' writes none. */
  joinType?: ShellJoinType;
  /** Chamfer only: second distance (or angle) — `chamfer(d1, d2, …)`. */
  distance2?: ValueExpr | null;
  /** Chamfer only: `distance2` is an angle in degrees — `chamfer(d, a, true, …)`. */
  isAngle?: boolean;
  /** Declarations the dialog's expression fields committed (`myVar = 50`). */
  newVariables?: NewVariable[];
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
  value: ValueExpr | null,
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
    planeRef: options.planeRef,
    edit: options.retarget,
    joinType: options.joinType,
    distance2: options.distance2,
    isAngle: options.isAngle,
    newVariables: options.newVariables,
    preview: options.preview,
  }, options.signal);
}

/**
 * Ask the server to synthesize (and, unless `preview` is set, apply) a
 * `project(<sources>)` statement inside the body of the sketch at `sketch`.
 * The picks are ordinary 3D edges and faces — the same synthesis the modify
 * tools use — but the emitted call lands in the sketch, not beside the
 * features it names.
 */
export async function applyProject(
  entities: ApplyFeatureEntity[],
  sketch: SketchSourceRef,
  options: {
    chains?: ApplyFeatureChain[];
    selectorOverride?: string;
    preview?: boolean;
    signal?: AbortSignal;
  } = {},
): Promise<ApplyFeatureResponse> {
  return postApplyFeature({
    feature: 'project',
    entities,
    sketch,
    chains: options.chains,
    selectorOverride: options.selectorOverride,
    preview: options.preview,
  }, options.signal);
}

export type ProjectEditOptions = EditSessionFields & {
  /** Edited source argument list; omitted keeps the statement's verbatim. */
  selectorOverride?: string;
  /** Re-picked 3D sources; omitted keeps the statement's own arguments. */
  entities?: ApplyFeatureEntity[];
  chains?: ApplyFeatureChain[];
  preview?: boolean;
  signal?: AbortSignal;
};

/** Rewrite the `project()` statement at `edit` in place. */
export async function applyProjectEdit(
  edit: FeatureEditTarget,
  options: ProjectEditOptions,
): Promise<ApplyFeatureResponse> {
  return postApplyFeature({
    feature: 'project',
    edit,
    expectedStatement: options.expectedStatement,
    before: options.before,
    entities: options.entities,
    chains: options.chains,
    selectorOverride: options.selectorOverride,
    preview: options.preview,
  }, options.signal);
}

/** A sketch-edge pick: 1 shapeId = 1 edge (no sub refs in 2D). */
export type SketchApplyEntity = { shapeId: string };

/** The 2D operations the sketch-branch apply supports. */
export type SketchOpFeature = 'fillet' | 'offset' | 'slot' | 'trim' | 'fuse' | 'subtract' | 'common';

/**
 * The offset dialog's two toggles: `removeOriginal` rides as the call's
 * second argument (`offset(2, true, …)`), `close` chains `.close()` to cap an
 * open offset onto its source profile. The kernel refuses the pair, so the
 * dialog keeps them mutually exclusive.
 */
export type OffsetOptionValues = {
  removeOriginal: boolean;
  close: boolean;
};

/**
 * The slot dialog's single toggle: `removeOriginal` mirrors the statement's
 * `deleteSource` argument (kernel default true) — `slot(l, 4)` consumes the
 * source line, `slot(l, 4, false)` keeps it.
 */
export type SlotOptionValues = {
  removeOriginal: boolean;
};

/**
 * Ask the server to synthesize (and, unless `preview` is set, apply) a 2D
 * operation for the picked sketch edges. The synthesized statement lands
 * inside the sketch body (`fillet(4, r.edge('top'), l)`,
 * `offset(2, r.edge('top'))`, `subtract(r, c)`). The booleans carry no
 * `value`; subtract is slot-addressed — `entities` is the base pick set and
 * `options.toolEntities` the tool's; offset carries its own toggles.
 */
export async function applySketchOp(
  feature: SketchOpFeature,
  value: ValueExpr | undefined,
  entities: SketchApplyEntity[],
  options: {
    toolEntities?: SketchApplyEntity[];
    offset?: OffsetOptionValues;
    slot?: SlotOptionValues;
    selectorOverride?: string;
    newVariables?: NewVariable[];
    preview?: boolean;
    signal?: AbortSignal;
  } = {},
): Promise<ApplyFeatureResponse> {
  return postApplyFeature({
    feature,
    value,
    sketchEntities: entities,
    sketchToolEntities: options.toolEntities,
    removeOriginal: options.offset?.removeOriginal ?? options.slot?.removeOriginal,
    close: options.offset?.close,
    selectorOverride: options.selectorOverride,
    newVariables: options.newVariables,
    preview: options.preview,
  }, options.signal);
}

/**
 * Commit the polyline tool's tangent-arc-to-edge snap: `tArc(<radius>,
 * <target>)`, where the picked edge's producing statement is bound to a
 * variable by the server and referenced as the target. The signed radius
 * follows the kernel's convention — positive curves left of the chain
 * tangent, negative right; the arc ends at its first intersection with the
 * target along the sweep.
 */
export async function applyTarcToEdge(
  radius: number,
  shapeId: string,
): Promise<ApplyFeatureResponse> {
  return postApplyFeature({
    feature: 'tarc',
    value: radius,
    sketchEntities: [{ shapeId }],
  });
}

/**
 * Rewrite the `tArc(radius, endPoint)` statement at `sourceLocation` to the
 * to-target overload — `tArc(radius, <target>)` — referencing the picked
 * edge's statement (an end-drag snapped onto it). The radius argument text
 * is preserved server-side; `sign` is the solved sweep in the to-target
 * convention (+1 CCW), applied by negating the radius for a clockwise arc.
 */
export async function retargetTarcToEdge(
  sourceLocation: SourceLocationParam,
  shapeId: string,
  sign: 1 | -1,
): Promise<ApplyFeatureResponse> {
  return postApplyFeature({
    feature: 'tarc',
    sketchEntities: [{ shapeId }],
    tarcRetarget: { line: sourceLocation.line, sign },
  });
}

export type OffsetEditOptions = OffsetOptionValues & EditSessionFields & {
  value: ValueExpr;
  /** Edited target argument list; omitted keeps the statement's verbatim. */
  selectorOverride?: string;
  /** Re-picked sketch edges; omitted keeps the statement's own targets. */
  entities?: SketchApplyEntity[];
  /** Declarations the dialog's expression field committed (`myVar = 50`). */
  newVariables?: NewVariable[];
  preview?: boolean;
  signal?: AbortSignal;
};

/**
 * Resolve the offset statement's target arguments onto the active (paused)
 * sketch's edges — the edit dialog seeds them as highlighted picks. A
 * refusal (`ok: false`) means the args use forms the resolver doesn't
 * cover; the dialog then keeps its keep chip unseeded.
 */
export async function fetchSketchFeatureSources(
  edit: FeatureEditTarget,
  expectedStatement?: string,
): Promise<{ ok: true; shapeIds: string[] } | { ok: false; reason: string }> {
  try {
    const res = await fetch('/api/sketch/feature-sources', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ edit, expectedStatement }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || body?.ok !== true) {
      return { ok: false, reason: body?.error ?? `Request failed (${res.status})` };
    }
    return { ok: true, shapeIds: body.shapeIds ?? [] };
  } catch {
    return { ok: false, reason: 'Could not reach the FluidCAD server' };
  }
}

/** Rewrite the 2D `offset()` statement at `edit` in place. */
export async function applyOffsetEdit(
  edit: FeatureEditTarget,
  options: OffsetEditOptions,
): Promise<ApplyFeatureResponse> {
  return postApplyFeature({
    feature: 'offset',
    edit,
    expectedStatement: options.expectedStatement,
    before: options.before,
    value: options.value,
    removeOriginal: options.removeOriginal,
    close: options.close,
    selectorOverride: options.selectorOverride,
    sketchEntities: options.entities,
    newVariables: options.newVariables,
    preview: options.preview,
  }, options.signal);
}

export type SlotEditOptions = SlotOptionValues & EditSessionFields & {
  value: ValueExpr;
  /** Edited source argument; omitted keeps the statement's verbatim. */
  selectorOverride?: string;
  /** Re-picked source edge(s); omitted keeps the statement's own source. */
  entities?: SketchApplyEntity[];
  /** Declarations the dialog's expression field committed (`myVar = 50`). */
  newVariables?: NewVariable[];
  preview?: boolean;
  signal?: AbortSignal;
};

/**
 * Replace the whole `slot()` statement at `edit` with a freshly drawn
 * from-dimensions form (the edit dialog's Draw tab): the drawing tool's
 * statement text swaps in verbatim, converting a from-edge slot back to a
 * drawn one.
 */
export async function applySlotDrawEdit(
  edit: FeatureEditTarget,
  options: EditSessionFields & {
    statement: string;
    newVariables?: NewVariable[];
    signal?: AbortSignal;
  },
): Promise<ApplyFeatureResponse> {
  return postApplyFeature({
    feature: 'slot',
    edit,
    expectedStatement: options.expectedStatement,
    before: options.before,
    drawStatement: options.statement,
    newVariables: options.newVariables,
  }, options.signal);
}

/** Rewrite the 2D `slot(<source>, <radius>[, false])` statement at `edit` in place. */
export async function applySlotEdit(
  edit: FeatureEditTarget,
  options: SlotEditOptions,
): Promise<ApplyFeatureResponse> {
  return postApplyFeature({
    feature: 'slot',
    edit,
    expectedStatement: options.expectedStatement,
    before: options.before,
    value: options.value,
    removeOriginal: options.removeOriginal,
    selectorOverride: options.selectorOverride,
    sketchEntities: options.entities,
    newVariables: options.newVariables,
    preview: options.preview,
  }, options.signal);
}

/** The constrained/free forms a chained sketch segment can be rewritten to. */
export type ConversionTarget = 'hLine' | 'vLine' | 'tLine' | 'aLine' | 'tArc' | 'free';

/** One conversion the mini-toolbar offers for the selected segment. */
export type ConversionOption = {
  target: ConversionTarget;
  enabled: boolean;
  /** Human-readable, for disabled-button tooltips. */
  reason?: string;
  /** Fully rendered call chain, e.g. `aLine(45, 141.42)`. */
  newStatement?: string;
  /** |new end − old end| in mm, for the UI to warn on snap size. */
  endpointDelta?: number;
  /**
   * Start-tangent deviation (degrees) an arc→tArc conversion re-bulges away;
   * endpoints stay put but the arc visibly reshapes.
   */
  reshapeAngle?: number;
};

export type SegmentConversionsResponse = {
  ok: boolean;
  /** Why nothing is convertible (not chained, buffer out of sync, …). */
  reason?: string;
  /** uniqueType of the owning feature, e.g. `line-two-points`. */
  currentKind?: string;
  sourceLocation?: SourceLocation;
  options?: ConversionOption[];
  /** Statement text the apply drift-guards against. */
  expectedStatement?: string;
};

/**
 * Legal conversions for the picked chained sketch segment. Refusal bodies
 * (422s) surface their reason so the mini-toolbar can tooltip it.
 */
export async function fetchSegmentConversions(
  shapeId: string,
  signal?: AbortSignal,
): Promise<SegmentConversionsResponse> {
  try {
    const res = await fetch('/api/sketch/segment-conversions', {
      method: 'POST',
      headers: JSON_HEADERS,
      signal,
      body: JSON.stringify({ shapeId }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      return { ok: false, reason: body?.error ?? `Request failed (${res.status})` };
    }
    return body ?? { ok: false, reason: 'Empty server response' };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw err;
    }
    return { ok: false, reason: 'Could not reach the FluidCAD server' };
  }
}

/**
 * Rewrite the segment's statement to `target`'s constrained (or free) form.
 * `expectedStatement` guards against the buffer having drifted since the
 * options were fetched.
 */
export async function convertSegment(
  shapeId: string,
  target: ConversionTarget,
  expectedStatement: string,
): Promise<{ success: boolean; reason?: string }> {
  try {
    const res = await fetch('/api/sketch/convert-segment', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ shapeId, target, expectedStatement }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      return { success: false, reason: body?.reason ?? body?.error ?? `Request failed (${res.status})` };
    }
    return body ?? { success: false, reason: 'Empty server response' };
  } catch {
    return { success: false, reason: 'Could not reach the FluidCAD server' };
  }
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
  distance: ValueExpr | null;
  /** Second (opposite-direction) distance — `extrude(d1, d2)`; excludes symmetric. */
  distance2: ValueExpr | null;
  /** `.symmetric()` — the distance splits equally across the sketch plane. */
  symmetric: boolean;
  /** `.draft(angle)` taper in degrees, or null for a straight extrude. */
  draft: ValueExpr | null;
  /** False writes `.drill(false)` — inner closed regions extrude as solid. */
  drill: boolean;
  /** `.thin()` offsets, or null for a plain extrude. */
  thin: [ValueExpr] | [ValueExpr, ValueExpr] | null;
  /** Declarations the dialog's expression fields committed (`myVar = 50`). */
  newVariables?: NewVariable[];
};

/**
 * The face an up-to-face extrude ends on when it is not a picked one: the
 * nearest or the farthest face the extrusion runs into, written as that
 * literal and resolved by the kernel.
 */
export type ExtrudeFaceTarget = 'first-face' | 'last-face';

export type ExtrudeApplyOptions = ExtrudeOptionValues & {
  profile: ExtrudeProfileRef;
  /** Up-to-face target replacing the distance(s): a picked face, or first/last. */
  toFace?: ApplyFeatureEntity | ExtrudeFaceTarget;
  /** Render the statement preview without applying. */
  preview?: boolean;
  signal?: AbortSignal;
};

/**
 * Ask the server to write (or, with `preview`, just render) an extrude/cut
 * statement consuming a sketch profile. Same endpoint and response shape as
 * {@link applyFeature}; the only pick involved is a picked up-to-face target,
 * synthesized into a face selector server-side.
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
    newVariables: options.newVariables,
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
  angle: ValueExpr;
  /** `.thin()` offsets, or null for a plain revolve. */
  thin: [ValueExpr] | [ValueExpr, ValueExpr] | null;
  /** Declarations the dialog's expression fields committed (`myVar = 50`). */
  newVariables?: NewVariable[];
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
    newVariables: options.newVariables,
    profile: options.profile,
    axis: options.axis,
    preview: options.preview,
  }, options.signal);
}

/**
 * The helix source: the revolve axis inputs (a standard world axis, an axis
 * statement by call site, or a picked edge synthesized into `axis(<edge>)`)
 * plus a picked cylindrical/conical face — its selector on its own.
 */
export type HelixSourceRef =
  | RevolveAxisRef
  | { kind: 'face'; entity: ApplyFeatureEntity };

/**
 * The helix geometry options the dialog edits, shared by create and edit
 * applies. Every field is optional — null omits its chained method so the
 * helix() API default applies (in face mode, radius/height default from the
 * face).
 */
export type HelixOptionValues = {
  /** Start radius; null uses the API default (20, or a face's radius). */
  radius: ValueExpr | null;
  /** End radius for a tapered (conical) helix; null keeps it cylindrical. */
  endRadius: ValueExpr | null;
  /** Axial rise per turn; null derives it from height and turns. */
  pitch: ValueExpr | null;
  /** Number of full turns; null uses the API default (1). */
  turns: ValueExpr | null;
  /** Total axial height; null uses pitch × turns, or the face's height. */
  height: ValueExpr | null;
  /** Shift the start along the axis; null is no shift. */
  startOffset: ValueExpr | null;
  /** Shift the end along the axis; null is no shift. */
  endOffset: ValueExpr | null;
  /** Declarations the dialog's expression fields committed (`myVar = 50`). */
  newVariables?: NewVariable[];
};

export type HelixApplyOptions = HelixOptionValues & {
  source: HelixSourceRef;
  /** Render the statement preview without applying. */
  preview?: boolean;
  signal?: AbortSignal;
};

/**
 * Ask the server to write (or, with `preview`, just render) a helix statement
 * — a helical wire around an axis or on a cylindrical/conical face. Same
 * endpoint and response shape as {@link applyFeature}.
 */
export async function applyHelix(options: HelixApplyOptions): Promise<ApplyFeatureResponse> {
  return postApplyFeature({
    feature: 'helix',
    source: options.source,
    radius: options.radius,
    endRadius: options.endRadius,
    pitch: options.pitch,
    turns: options.turns,
    height: options.height,
    startOffset: options.startOffset,
    endOffset: options.endOffset,
    newVariables: options.newVariables,
    preview: options.preview,
  }, options.signal);
}

export type SweepApplyOptions = {
  op: 'add' | 'remove' | 'new';
  /** `.thin()` offsets, or null for a plain sweep. */
  thin: [ValueExpr] | [ValueExpr, ValueExpr] | null;
  /** Declarations the dialog's expression fields committed (`myVar = 50`). */
  newVariables?: NewVariable[];
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
    newVariables: options.newVariables,
    profile: options.profile,
    path: options.path,
    preview: options.preview,
  }, options.signal);
}

/** The wrap options the dialog edits, shared by create and edit applies. */
export type WrapOptionValues = {
  op: 'add' | 'remove' | 'new';
  /** Pad thickness along the surface normal (always positive). */
  thickness: ValueExpr;
  /** Declarations the dialog's expression fields committed (`myVar = 50`). */
  newVariables?: NewVariable[];
};

export type WrapApplyOptions = WrapOptionValues & {
  /** The sketch to wrap — always bound to a variable (wrap takes it explicitly). */
  sketch: SketchSourceRef;
  /** The target face to wrap onto, synthesized into a face selector. */
  face: ApplyFeatureEntity;
  /** Render the statement preview without applying. */
  preview?: boolean;
  signal?: AbortSignal;
};

/**
 * Ask the server to write (or, with `preview`, just render) a wrap statement
 * developing a sketch onto a curved face. Same endpoint and response shape as
 * {@link applyFeature}.
 */
export async function applyWrap(options: WrapApplyOptions): Promise<ApplyFeatureResponse> {
  return postApplyFeature({
    feature: 'wrap',
    op: options.op,
    thickness: options.thickness,
    newVariables: options.newVariables,
    sketch: options.sketch,
    face: options.face,
    preview: options.preview,
  }, options.signal);
}

/** One ordered loft profile: a sketch, or a face picked in the 3D view. */
export type LoftProfileRef =
  | ({ kind: 'sketch' } & SketchSourceRef)
  | { kind: 'face'; entity: ApplyFeatureEntity };

/** A `.startCondition()`/`.endCondition()` takeoff constraint; null = none. */
export type LoftConditionRef = { type: 'normal' | 'tangent'; magnitude: ValueExpr };

export type LoftApplyOptions = {
  op: 'add' | 'remove' | 'new';
  /** `.thin()` offsets, or null for a plain loft. */
  thin: [ValueExpr] | [ValueExpr, ValueExpr] | null;
  /** Declarations the dialog's expression fields committed (`myVar = 50`). */
  newVariables?: NewVariable[];
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
    newVariables: options.newVariables,
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
  | ({ kind: 'plane' } & SketchSourceRef)
  /** A helix statement as the edge-plane base (its wire is the edge). */
  | ({ kind: 'wire' } & SketchSourceRef);

export type PlaneApplyOptions = {
  /** `offset`/`edge` take one base; `mid` takes two. */
  type: 'offset' | 'mid' | 'edge';
  /** Normal offset distance; null renders none. Offset type only. */
  offset: ValueExpr | null;
  /** Rotation in degrees around the plane's local axes; null renders none. */
  rotateX: ValueExpr | null;
  rotateY: ValueExpr | null;
  rotateZ: ValueExpr | null;
  /** Normalized 0–1 position along the edge (edge type only). */
  position: ValueExpr | null;
  bases: PlaneBaseRef[];
  /** Declarations the dialog's expression fields committed (`myVar = 50`). */
  newVariables?: NewVariable[];
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
    newVariables: options.newVariables,
    preview: options.preview,
  }, options.signal);
}

/**
 * The mirror plane of a repeat request: a standard origin plane, an existing
 * plane feature addressed by its source location, or a picked face —
 * synthesized into `plane(<face selector>)` server-side.
 */
export type RepeatPlaneRef =
  | { kind: 'standard'; plane: 'xy' | 'xz' | 'yz' }
  | ({ kind: 'plane' } & SketchSourceRef)
  | { kind: 'face'; entity: ApplyFeatureEntity };

/** One linear direction: its axis plus that direction's count and value. */
export type RepeatDirectionRef = {
  /** The direction's axis — the revolve axis shapes. */
  axis: RevolveAxisRef;
  /** Instance count along this direction, the original included. */
  count: ValueExpr;
  /** Spacing along this direction, read through the shared `spacingMode`. */
  value: ValueExpr;
};

export type RepeatApplyOptions = {
  kind: 'linear' | 'circular' | 'mirror' | 'rotate';
  /** The feature statements being repeated (timeline picks), in order. */
  targets: SketchSourceRef[];
  /** Linear directions in axis order — each its own axis, count and value. */
  directions?: RepeatDirectionRef[];
  /** Linear spacing semantics shared by every direction. */
  spacingMode?: 'offset' | 'length';
  /** The repeat axis (circular/rotate) — the revolve axis shapes. */
  axis?: RevolveAxisRef;
  /** The mirror plane (mirror only). */
  plane?: RepeatPlaneRef;
  /** Instance count, original included (circular). */
  count?: ValueExpr;
  /** Circular sweep: total `angle` or per-instance `offset`, in degrees. */
  sweep?: { mode: 'angle' | 'offset'; value: ValueExpr };
  /** Linear only: center the pattern on the original instance. */
  centered?: boolean;
  /** Rotate only: rotation angle in degrees. */
  angle?: ValueExpr;
  /** Declarations the dialog's expression fields committed (`myVar = 50`). */
  newVariables?: NewVariable[];
  /** Render the statement preview without applying. */
  preview?: boolean;
  signal?: AbortSignal;
};

/**
 * Ask the server to write (or, with `preview`, just render) a repeat
 * statement replaying the target features. Same endpoint and response shape
 * as {@link applyFeature}.
 */
export async function applyRepeat(options: RepeatApplyOptions): Promise<ApplyFeatureResponse> {
  return postApplyFeature({
    feature: 'repeat',
    kind: options.kind,
    targets: options.targets,
    directions: options.directions,
    spacingMode: options.spacingMode,
    axis: options.axis,
    plane: options.plane,
    count: options.count,
    sweep: options.sweep,
    centered: options.centered,
    angle: options.angle,
    newVariables: options.newVariables,
    preview: options.preview,
  }, options.signal);
}

/** One linear copy direction: its axis plus that direction's count and value. */
export type CopyDirectionRef = {
  /** The direction's axis — the revolve axis shapes. */
  axis: RevolveAxisRef;
  /** Instance count along this direction, the original included. */
  count: ValueExpr;
  /** Spacing along this direction, read through the shared `spacingMode`. */
  value: ValueExpr;
};

export type CopyApplyOptions = {
  kind: 'linear' | 'circular';
  /** The solid-bearing statements being copied (whole-solid picks), in order. */
  targets: SketchSourceRef[];
  /** Linear directions in axis order — each its own axis, count and value. */
  directions?: CopyDirectionRef[];
  /** Linear spacing semantics shared by every direction. */
  spacingMode?: 'offset' | 'length';
  /** The copy axis (circular) — the revolve axis shapes. */
  axis?: RevolveAxisRef;
  /** Instance count, original included (circular). */
  count?: ValueExpr;
  /** Circular sweep: total `angle` or per-instance `offset`, in degrees. */
  sweep?: { mode: 'angle' | 'offset'; value: ValueExpr };
  /** Linear only: center the copies on the original instance. */
  centered?: boolean;
  /** Declarations the dialog's expression fields committed (`myVar = 50`). */
  newVariables?: NewVariable[];
  /** Render the statement preview without applying. */
  preview?: boolean;
  signal?: AbortSignal;
};

/**
 * Ask the server to write (or, with `preview`, just render) a copy statement
 * cloning the target solids. Same endpoint and response shape as
 * {@link applyFeature}.
 */
export async function applyCopy(options: CopyApplyOptions): Promise<ApplyFeatureResponse> {
  return postApplyFeature({
    feature: 'copy',
    kind: options.kind,
    targets: options.targets,
    directions: options.directions,
    spacingMode: options.spacingMode,
    axis: options.axis,
    count: options.count,
    sweep: options.sweep,
    centered: options.centered,
    newVariables: options.newVariables,
    preview: options.preview,
  }, options.signal);
}

/** The three boolean operations — each its own callee, one shared dialog. */
export type BooleanKind = 'fuse' | 'subtract' | 'common';

export type BooleanApplyOptions = {
  kind: BooleanKind;
  /**
   * The solid-bearing statements being combined (whole-solid picks), in
   * argument order — [base, tool] for subtract, two or more for fuse/common.
   */
  targets: SketchSourceRef[];
  /** Render the statement preview without applying. */
  preview?: boolean;
  signal?: AbortSignal;
};

/**
 * Ask the server to write (or, with `preview`, just render) a boolean
 * statement — `fuse(a, b)`, `subtract(base, tool)` or `common(a, b)` —
 * combining the target solids. Same endpoint and response shape as
 * {@link applyFeature}.
 */
export async function applyBoolean(options: BooleanApplyOptions): Promise<ApplyFeatureResponse> {
  return postApplyFeature({
    feature: 'boolean',
    kind: options.kind,
    targets: options.targets,
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
  | { ok: true; feature: 'wrap'; sketch: SourceSlotRef; face: SourceSlotRef }
  | { ok: true; feature: 'loft'; profiles: SourceSlotRef[]; guides: SourceSlotRef[] }
  | { ok: true; feature: 'revolve'; profile: SourceSlotRef; axis: SourceSlotRef }
  | { ok: true; feature: 'helix'; source: SourceSlotRef }
  | { ok: true; feature: 'shell' | 'fillet' | 'chamfer'; selection: SourceSlotRef }
  | { ok: true; feature: 'projection'; selection: SourceSlotRef }
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
 * One base argument of a parsed plane statement. `kind` is what the base
 * READS AS: 'plane' for a plane-like (an origin-plane literal, a plane
 * variable, a nested `plane(…)`), 'edge' for an edge source (an edge
 * selector or a helix variable), 'face' for anything else — it decides which
 * dialog types can keep the base.
 */
export type ParsedPlaneBase = {
  /** Argument text, verbatim. */
  text: string;
  kind: 'plane' | 'face' | 'edge';
  /** The origin plane when the text is a standard plane literal. */
  standard: 'xy' | 'xz' | 'yz' | null;
  /**
   * Source location of the statement a plain-identifier base references, or
   * null when the expression doesn't resolve to one — seeds the base as its
   * plane/helix row.
   */
  ref: { line: number; column: number } | null;
};

/**
 * An existing statement's dialog-editable reading (mirror of the server's
 * `ParsedFeatureStatement`). Expressions the dialogs don't edit (profiles,
 * paths, selector args) arrive as verbatim source text.
 */
export type ParsedFeatureStatement =
  | {
      feature: 'extrude';
      op: FeatureOpKind;
      distance: ValueExpr | null;
      distance2: ValueExpr | null;
      symmetric: boolean;
      draft: ValueExpr | null;
      drill: boolean;
      thin: [ValueExpr] | null;
      profileText: string | null;
      /** Up-to-face target argument text, or null for a distance extrude. */
      toFaceText: string | null;
      /**
       * The target's kind — a picked face's selector, or the first/last-face
       * literal; null for a distance extrude.
       */
      toFaceKind: 'selector' | ExtrudeFaceTarget | null;
    }
  | {
      feature: 'sweep';
      op: FeatureOpKind;
      thin: [ValueExpr] | null;
      pathText: string;
      profileText: string | null;
    }
  | {
      feature: 'wrap';
      op: FeatureOpKind;
      /** Pad thickness along the surface normal (always positive). */
      thickness: ValueExpr;
      /** Sketch argument text, verbatim (`s`). */
      sketchText: string;
      /** Target face argument text, verbatim (`e.sideFaces(0)`). */
      faceText: string;
    }
  | {
      feature: 'revolve';
      op: FeatureOpKind;
      /** Sweep angle in degrees; null = omitted (the 360° API default). */
      angle: ValueExpr | null;
      thin: [ValueExpr] | null;
      /** Axis argument text, verbatim (`'z'`, `a`, `axis(e.edges(3))`). */
      axisText: string;
      profileText: string | null;
    }
  | {
      feature: 'helix';
      /** Source argument text, verbatim (`'z'`, `a`, `axis(e.edges(3))`, `e.sideFaces(0)`). */
      sourceText: string;
      /** The tab the dialog opens on — a face selector reads 'face', all else 'axis'. */
      sourceMode: 'axis' | 'face';
      radius: ValueExpr | null;
      endRadius: ValueExpr | null;
      pitch: ValueExpr | null;
      turns: ValueExpr | null;
      height: ValueExpr | null;
      startOffset: ValueExpr | null;
      endOffset: ValueExpr | null;
    }
  | {
      feature: 'loft';
      op: FeatureOpKind;
      thin: [ValueExpr] | null;
      profileTexts: string[];
      guideTexts: string[];
      startCondition: LoftConditionRef | null;
      endCondition: LoftConditionRef | null;
    }
  | {
      feature: 'shell';
      value: ValueExpr;
      argsText: string;
      /** `.join()` type; 'arc' (the kernel default) when the chain is absent. */
      joinType: ShellJoinType;
    }
  | { feature: 'fillet'; value: ValueExpr; argsText: string }
  | {
      feature: 'offset';
      /** The offset distance; negative offsets inward. */
      value: ValueExpr;
      /** The literal `true` second argument — the sources are removed. */
      removeOriginal: boolean;
      /** Target argument list after the value slots, verbatim (`''` when absent). */
      argsText: string;
      /** `.close()` chains the offset back onto its source profile. */
      close: boolean;
    }
  | {
      feature: 'slot';
      /** The end-cap radius. */
      value: ValueExpr;
      /** The `deleteSource` argument (kernel default true) — the source is removed. */
      removeOriginal: boolean;
      /** The source-geometry argument, verbatim (a bound variable). */
      argsText: string;
    }
  | {
      feature: 'project';
      /** The projected source argument list, verbatim (`''` when absent). */
      argsText: string;
    }
  | {
      feature: 'chamfer';
      value: ValueExpr;
      argsText: string;
      /** Second distance (or angle) argument; null for the equal-distance form. */
      distance2: ValueExpr | null;
      /** The literal `true` third argument — `distance2` is an angle in degrees. */
      isAngle: boolean;
    }
  | {
      feature: 'sketch';
      /** Plane/face target argument text, verbatim; null for the bare form. */
      targetText: string | null;
      /** The body callback argument text, verbatim — never dialog-edited. */
      bodyText: string;
    }
  | ({
      feature: 'text';
      /** Path argument text, verbatim; null for plain (non-path) text. */
      pathText: string | null;
    } & TextOptionValues)
  | {
      feature: 'repeat';
      kind: 'linear' | 'circular' | 'mirror' | 'rotate';
      /**
       * Axis argument texts, verbatim — one per linear direction, a single
       * entry for circular/rotate, empty for mirror.
       */
      axisTexts: string[];
      /** Mirror plane argument text, verbatim; null for the axis kinds. */
      planeText: string | null;
      /** Linear per-direction count and value, in axis order. */
      directions: { count: ValueExpr; value: ValueExpr }[] | null;
      /** Linear spacing semantics shared by every direction. */
      spacingMode: 'offset' | 'length' | null;
      /** Linear only: the pattern is centered on the original instance. */
      centered: boolean;
      /** Circular instance count, original included. */
      count: ValueExpr | null;
      /** Circular sweep: total `angle` or per-instance `offset`, in degrees. */
      sweep: { mode: 'angle' | 'offset'; value: ValueExpr } | null;
      /** Rotate angle in degrees; null = omitted (the 90° API default). */
      angle: ValueExpr | null;
      /** Trailing target texts, verbatim; empty replays the previous feature. */
      targetTexts: string[];
      /**
       * Per-target source location of the feature statement a plain-identifier
       * target references, or null when the expression doesn't resolve to one.
       * Same length as `targetTexts` — seeds each target as its timeline row.
       */
      targetRefs: ({ line: number; column: number } | null)[];
    }
  | {
      feature: 'copy';
      kind: 'linear' | 'circular';
      /**
       * Axis argument texts, verbatim — one per linear direction, a single
       * entry for circular.
       */
      axisTexts: string[];
      /** Linear per-direction count and value, in axis order. */
      directions: { count: ValueExpr; value: ValueExpr }[] | null;
      /** Linear spacing semantics shared by every direction. */
      spacingMode: 'offset' | 'length' | null;
      /** Linear only: the copies are centered on the original instance. */
      centered: boolean;
      /** Circular instance count, original included. */
      count: ValueExpr | null;
      /** Circular sweep: total `angle` or per-instance `offset`, in degrees. */
      sweep: { mode: 'angle' | 'offset'; value: ValueExpr } | null;
      /** Trailing target texts, verbatim; empty copies every active solid. */
      targetTexts: string[];
      /**
       * Per-target source location of the statement a plain-identifier target
       * references, or null when the expression doesn't resolve to one. Same
       * length as `targetTexts` — seeds each target as its solid option.
       */
      targetRefs: ({ line: number; column: number } | null)[];
    }
  | {
      feature: 'plane';
      /**
       * The form the dialog opens on: two bases read as a mid plane, a lone
       * edge base carrying a position as the edge form, everything else as
       * an offset plane.
       */
      type: 'offset' | 'mid' | 'edge';
      /** The base arguments, in argument order: one, or two for a mid plane. */
      bases: ParsedPlaneBase[];
      /** Offset along the base normal; null when the statement writes none. */
      offset: ValueExpr | null;
      rotateX: ValueExpr | null;
      rotateY: ValueExpr | null;
      rotateZ: ValueExpr | null;
      /** Normalized 0–1 position along the edge; null for the other forms. */
      position: ValueExpr | null;
    }
  | {
      feature: 'boolean';
      /** The statement's own callee — fuse, subtract or common. */
      kind: BooleanKind;
      /**
       * Target texts, verbatim, in argument order; empty operates on every
       * active shape.
       */
      targetTexts: string[];
      /**
       * Per-target source location of the statement a plain-identifier target
       * references, or null when the expression doesn't resolve to one. Same
       * length as `targetTexts` — seeds each target as its solid option.
       */
      targetRefs: ({ line: number; column: number } | null)[];
    };

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
   * `face` re-picks it, `first-face`/`last-face` swap it for that literal.
   * Omitted writes the distance form (dropping any target the statement had).
   */
  toFace?: { kind: 'keep' | ExtrudeFaceTarget } | { kind: 'face'; entity: ApplyFeatureEntity };
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
    newVariables: options.newVariables,
    profile: options.profile,
    toFace: options.toFace,
    preview: options.preview,
  }, options.signal);
}

export type SweepEditOptions = EditSessionFields & {
  op: FeatureOpKind;
  thin: [ValueExpr] | [ValueExpr, ValueExpr] | null;
  /** Declarations the dialog's expression fields committed (`myVar = 50`). */
  newVariables?: NewVariable[];
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
    newVariables: options.newVariables,
    path: options.path,
    profile: options.profile,
    preview: options.preview,
  }, options.signal);
}

export type WrapEditOptions = WrapOptionValues & EditSessionFields & {
  /** Re-sourced sketch; omitted keeps the statement's own. */
  sketch?: { kind: 'sketch' } & SketchSourceRef;
  /**
   * Target face: `keep` re-emits the statement's own face text, `face`
   * re-picks it. Omitted also keeps the statement's own.
   */
  face?: { kind: 'keep' } | { kind: 'face'; entity: ApplyFeatureEntity };
  preview?: boolean;
  signal?: AbortSignal;
};

/** Rewrite the wrap statement at `edit` in place. */
export async function applyWrapEdit(
  edit: FeatureEditTarget,
  options: WrapEditOptions,
): Promise<ApplyFeatureResponse> {
  return postApplyFeature({
    feature: 'wrap',
    edit,
    expectedStatement: options.expectedStatement,
    before: options.before,
    op: options.op,
    thickness: options.thickness,
    newVariables: options.newVariables,
    sketch: options.sketch,
    face: options.face,
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
    newVariables: options.newVariables,
    profile: options.profile,
    axis: options.axis,
    preview: options.preview,
  }, options.signal);
}

export type HelixEditOptions = HelixOptionValues & EditSessionFields & {
  /** Re-sourced source (axis-family or face); omitted keeps the statement's own. */
  source?: HelixSourceRef;
  preview?: boolean;
  signal?: AbortSignal;
};

/** Rewrite the helix statement at `edit` in place. */
export async function applyHelixEdit(
  edit: FeatureEditTarget,
  options: HelixEditOptions,
): Promise<ApplyFeatureResponse> {
  return postApplyFeature({
    feature: 'helix',
    edit,
    expectedStatement: options.expectedStatement,
    before: options.before,
    source: options.source,
    radius: options.radius,
    endRadius: options.endRadius,
    pitch: options.pitch,
    turns: options.turns,
    height: options.height,
    startOffset: options.startOffset,
    endOffset: options.endOffset,
    newVariables: options.newVariables,
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
  thin: [ValueExpr] | [ValueExpr, ValueExpr] | null;
  /** Declarations the dialog's expression fields committed (`myVar = 50`). */
  newVariables?: NewVariable[];
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
    newVariables: options.newVariables,
    startCondition: options.startCondition,
    endCondition: options.endCondition,
    profiles: options.profiles,
    guides: options.guides,
    preview: options.preview,
  }, options.signal);
}

/**
 * One axis slot of an edited repeat: keep the statement's own axis text by
 * its position in the parsed `axisTexts`, or re-source it with any
 * create-mode axis shape.
 */
export type RepeatEditAxisRef = { kind: 'keep'; sourceIndex: number } | RevolveAxisRef;

/** The mirror-plane slot of an edited repeat: keep, or re-source. */
export type RepeatEditPlaneRef = { kind: 'keep' } | RepeatPlaneRef;

/**
 * One target of an edited repeat, in argument order: an untouched target by
 * its position in the statement's own argument list, or a re-picked feature
 * statement by call site.
 */
export type RepeatEditTargetRef =
  | { kind: 'verbatim'; sourceIndex: number }
  | ({ kind: 'feature' } & SketchSourceRef);

export type RepeatEditOptions = EditSessionFields & {
  kind: 'linear' | 'circular' | 'mirror' | 'rotate';
  /** Linear directions in axis order — each its own axis, count and value. */
  directions?: { axis: RepeatEditAxisRef; count: ValueExpr; value: ValueExpr }[];
  /** Linear spacing semantics shared by every direction. */
  spacingMode?: 'offset' | 'length';
  /** Linear only: center the pattern on the original instance. */
  centered?: boolean;
  /** The repeat axis (circular/rotate); omitted keeps the statement's own. */
  axis?: RepeatEditAxisRef;
  /** The mirror plane; omitted keeps the statement's own. */
  plane?: RepeatEditPlaneRef;
  /** Instance count, original included (circular). */
  count?: ValueExpr;
  /** Circular sweep: total `angle` or per-instance `offset`, in degrees. */
  sweep?: { mode: 'angle' | 'offset'; value: ValueExpr };
  /** Rotate only: rotation angle in degrees. */
  angle?: ValueExpr;
  /** Declarations the dialog's expression fields committed (`myVar = 50`). */
  newVariables?: NewVariable[];
  /** Full replacement target list; omitted keeps the statement's own. */
  targets?: RepeatEditTargetRef[];
  preview?: boolean;
  signal?: AbortSignal;
};

/** Rewrite the repeat statement at `edit` in place. */
export async function applyRepeatEdit(
  edit: FeatureEditTarget,
  options: RepeatEditOptions,
): Promise<ApplyFeatureResponse> {
  return postApplyFeature({
    feature: 'repeat',
    edit,
    expectedStatement: options.expectedStatement,
    before: options.before,
    kind: options.kind,
    directions: options.directions,
    spacingMode: options.spacingMode,
    centered: options.centered,
    axis: options.axis,
    plane: options.plane,
    count: options.count,
    sweep: options.sweep,
    angle: options.angle,
    newVariables: options.newVariables,
    targets: options.targets,
    preview: options.preview,
  }, options.signal);
}

/**
 * One axis slot of an edited copy: keep the statement's own axis text by its
 * position in the parsed `axisTexts`, or re-source it with any create-mode
 * axis shape.
 */
export type CopyEditAxisRef = { kind: 'keep'; sourceIndex: number } | RevolveAxisRef;

/**
 * One target of an edited copy, in argument order: an untouched target by
 * its position in the statement's own argument list, or a re-picked solid
 * statement by call site.
 */
export type CopyEditTargetRef =
  | { kind: 'verbatim'; sourceIndex: number }
  | ({ kind: 'feature' } & SketchSourceRef);

export type CopyEditOptions = EditSessionFields & {
  kind: 'linear' | 'circular';
  /** Linear directions in axis order — each its own axis, count and value. */
  directions?: { axis: CopyEditAxisRef; count: ValueExpr; value: ValueExpr }[];
  /** Linear spacing semantics shared by every direction. */
  spacingMode?: 'offset' | 'length';
  /** Linear only: center the copies on the original instance. */
  centered?: boolean;
  /** The copy axis (circular); omitted keeps the statement's own. */
  axis?: CopyEditAxisRef;
  /** Instance count, original included (circular). */
  count?: ValueExpr;
  /** Circular sweep: total `angle` or per-instance `offset`, in degrees. */
  sweep?: { mode: 'angle' | 'offset'; value: ValueExpr };
  /** Declarations the dialog's expression fields committed (`myVar = 50`). */
  newVariables?: NewVariable[];
  /** Full replacement target list; omitted keeps the statement's own. */
  targets?: CopyEditTargetRef[];
  preview?: boolean;
  signal?: AbortSignal;
};

/** Rewrite the copy statement at `edit` in place. */
export async function applyCopyEdit(
  edit: FeatureEditTarget,
  options: CopyEditOptions,
): Promise<ApplyFeatureResponse> {
  return postApplyFeature({
    feature: 'copy',
    edit,
    expectedStatement: options.expectedStatement,
    before: options.before,
    kind: options.kind,
    directions: options.directions,
    spacingMode: options.spacingMode,
    centered: options.centered,
    axis: options.axis,
    count: options.count,
    sweep: options.sweep,
    newVariables: options.newVariables,
    targets: options.targets,
    preview: options.preview,
  }, options.signal);
}

/**
 * One target of an edited boolean, in argument order: an untouched target by
 * its position in the statement's own argument list, or a re-picked solid
 * statement by call site.
 */
export type BooleanEditTargetRef =
  | { kind: 'verbatim'; sourceIndex: number }
  | ({ kind: 'feature' } & SketchSourceRef);

export type BooleanEditOptions = EditSessionFields & {
  /** The callee to write — an edit may rewrite a fuse into a subtract. */
  kind: BooleanKind;
  /** Full replacement target list; omitted keeps the statement's own. */
  targets?: BooleanEditTargetRef[];
  preview?: boolean;
  signal?: AbortSignal;
};

/** Rewrite the boolean statement at `edit` in place. */
export async function applyBooleanEdit(
  edit: FeatureEditTarget,
  options: BooleanEditOptions,
): Promise<ApplyFeatureResponse> {
  return postApplyFeature({
    feature: 'boolean',
    edit,
    expectedStatement: options.expectedStatement,
    kind: options.kind,
    targets: options.targets,
    preview: options.preview,
  }, options.signal);
}

/**
 * One base of an edited plane, in argument order: an untouched base by its
 * position in the statement's own argument list, or any re-sourced
 * create-mode base.
 */
export type PlaneEditBaseRef =
  | { kind: 'verbatim'; sourceIndex: number }
  | PlaneBaseRef;

export type PlaneEditOptions = EditSessionFields & {
  /** `offset`/`edge` take one base; `mid` takes two. */
  type: 'offset' | 'mid' | 'edge';
  /** Normal offset distance; null renders none. Offset type only. */
  offset: ValueExpr | null;
  /** Rotation in degrees around the plane's local axes; null renders none. */
  rotateX: ValueExpr | null;
  rotateY: ValueExpr | null;
  rotateZ: ValueExpr | null;
  /** Normalized 0–1 position along the edge (edge type only). */
  position: ValueExpr | null;
  /** Full replacement base list; omitted keeps the statement's own. */
  bases?: PlaneEditBaseRef[];
  /** Declarations the dialog's expression fields committed (`myVar = 50`). */
  newVariables?: NewVariable[];
  preview?: boolean;
  signal?: AbortSignal;
};

/** Rewrite the plane statement at `edit` in place. */
export async function applyPlaneEdit(
  edit: FeatureEditTarget,
  options: PlaneEditOptions,
): Promise<ApplyFeatureResponse> {
  return postApplyFeature({
    feature: 'plane',
    edit,
    expectedStatement: options.expectedStatement,
    before: options.before,
    type: options.type,
    offset: options.offset,
    rotateX: options.rotateX,
    rotateY: options.rotateY,
    rotateZ: options.rotateZ,
    position: options.position,
    bases: options.bases,
    newVariables: options.newVariables,
    preview: options.preview,
  }, options.signal);
}

export type TextEditOptions = TextOptionValues & EditSessionFields & {
  preview?: boolean;
  signal?: AbortSignal;
};

/** Rewrite the text statement at `edit` in place (pick-less, no boundary). */
export async function applyTextEdit(
  edit: FeatureEditTarget,
  options: TextEditOptions,
): Promise<ApplyFeatureResponse> {
  return postApplyFeature({
    feature: 'text',
    edit,
    expectedStatement: options.expectedStatement,
    text: options.text,
    size: options.size,
    font: options.font,
    weight: options.weight,
    italic: options.italic,
    align: options.align,
    lineSpacing: options.lineSpacing,
    letterSpacing: options.letterSpacing,
    preview: options.preview,
  }, options.signal);
}

export type ValueFeatureEditOptions = EditSessionFields & {
  value: ValueExpr;
  /** Edited selector argument list; omitted keeps the statement's verbatim. */
  selectorOverride?: string;
  /** Shell only: rewrites the `.join('<type>')` chain; 'arc' writes none. */
  joinType?: ShellJoinType;
  /** Chamfer only: second value slot; null returns to the equal-distance form. */
  distance2?: ValueExpr | null;
  /** Chamfer only: `distance2` is an angle in degrees. */
  isAngle?: boolean;
  /** Declarations the dialog's expression fields committed (`myVar = 50`). */
  newVariables?: NewVariable[];
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
    distance2: options.distance2,
    isAngle: options.isAngle,
    newVariables: options.newVariables,
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
  callee: 'sketch' | 'plane' | 'axis' | 'helix' = 'sketch',
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

export function removeFeature(sourceLocation: SourceLocationParam): void {
  postFireAndForget('/api/remove-feature', { sourceLocation });
}

/** Set (or, with null/empty, clear) the feature's chained `.name('…')`. */
export function renameFeature(sourceLocation: SourceLocationParam, name: string | null): void {
  postFireAndForget('/api/rename-feature', { sourceLocation, name });
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

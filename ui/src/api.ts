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

export type ApplyFeatureOptions = {
  chains?: ApplyFeatureChain[];
  /** User-edited argument list; replaces the synthesized selectors verbatim. */
  selectorOverride?: string;
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

export type ExtrudeApplyOptions = {
  op: 'add' | 'remove' | 'new';
  /** Extrusion distance; null is a through-all remove. */
  distance: number | null;
  /** `.thin()` offsets, or null for a plain extrude. */
  thin: [number] | [number, number] | null;
  profile: ExtrudeProfileRef;
  /** Render the statement preview without applying. */
  preview?: boolean;
  signal?: AbortSignal;
};

/**
 * Ask the server to write (or, with `preview`, just render) an extrude/cut
 * statement consuming a sketch profile. Same endpoint and response shape as
 * {@link applyFeature}, but no pick selection is involved.
 */
export async function applyExtrude(options: ExtrudeApplyOptions): Promise<ApplyFeatureResponse> {
  return postApplyFeature({
    feature: 'extrude',
    op: options.op,
    distance: options.distance,
    thin: options.thin,
    profile: options.profile,
    preview: options.preview,
  }, options.signal);
}

/** A sketch input addressed by its rendered source location. */
export type SketchSourceRef = { filePath: string; line: number; column: number };

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

// ---------------------------------------------------------------------------
// Feature statement editing (timeline double-click → edit dialog)
// ---------------------------------------------------------------------------

/** The statement a double-clicked timeline row edits, by source location. */
export type FeatureEditTarget = SketchSourceRef;

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
      thin: [number] | null;
      profileText: string | null;
    }
  | {
      feature: 'sweep';
      op: FeatureOpKind;
      thin: [number] | null;
      pathText: string;
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
  | { feature: 'shell' | 'fillet' | 'chamfer'; value: number; argsText: string };

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

export type ExtrudeEditOptions = {
  op: FeatureOpKind;
  distance: number | null;
  thin: [number] | [number, number] | null;
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
    op: options.op,
    distance: options.distance,
    thin: options.thin,
    preview: options.preview,
  }, options.signal);
}

export type SweepEditOptions = {
  op: FeatureOpKind;
  thin: [number] | [number, number] | null;
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
    op: options.op,
    thin: options.thin,
    preview: options.preview,
  }, options.signal);
}

export type LoftEditOptions = {
  op: FeatureOpKind;
  thin: [number] | [number, number] | null;
  startCondition: LoftConditionRef | null;
  endCondition: LoftConditionRef | null;
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
    op: options.op,
    thin: options.thin,
    startCondition: options.startCondition,
    endCondition: options.endCondition,
    preview: options.preview,
  }, options.signal);
}

export type ValueFeatureEditOptions = {
  value: number;
  /** Edited selector argument list; omitted keeps the statement's verbatim. */
  selectorOverride?: string;
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
    value: options.value,
    selectorOverride: options.selectorOverride,
    preview: options.preview,
  }, options.signal);
}

/**
 * Variable names of the sketch statements at the given source lines (dialog
 * labels). Unbound or unresolvable lines come back null; failures degrade to
 * all-null — the labels are cosmetic.
 */
export async function fetchSketchNames(lines: number[]): Promise<(string | null)[]> {
  try {
    const res = await fetch('/api/sketch-names', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ lines }),
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

/** Expand a picked edge/face to its tangent chain on the owning solid. */
export async function expandTangents(
  entity: ApplyFeatureEntity,
): Promise<{ members: ApplyFeatureEntity[] } | { error: string }> {
  return expandSelection('/api/selection/expand-tangents', entity);
}

/** Expand a picked edge/face to its whole classified bucket. */
export async function expandBucket(
  entity: ApplyFeatureEntity,
): Promise<{ members: ApplyFeatureEntity[] } | { error: string }> {
  return expandSelection('/api/selection/expand-bucket', entity);
}

async function expandSelection(
  endpoint: string,
  entity: ApplyFeatureEntity,
): Promise<{ members: ApplyFeatureEntity[] } | { error: string }> {
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ entity }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      return { error: body?.error ?? `Request failed (${res.status})` };
    }
    return body ?? { error: 'Empty server response' };
  } catch {
    return { error: 'Could not reach the FluidCAD server' };
  }
}

export function explainSelection(
  entities: ApplyFeatureEntity[],
  signal?: AbortSignal,
): Promise<{ picks: any[] } | null> {
  return postJson('/api/selection/explain', { entities }, signal);
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

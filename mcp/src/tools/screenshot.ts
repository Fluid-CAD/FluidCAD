// Screenshot tools — render the running FluidCAD scene as a PNG and return
// MCP `image` content blocks. Views are stateless: the agent picks a vantage
// (named view, orbit-from-current, or look-from) and the user's interactive
// camera is never touched.

import { resolveClient, type WorkspaceArg } from './inspection.ts';
import { FluidCadClient, HttpError } from '../client.ts';
import { err, ok, type ToolResult } from '../types.ts';

const NAMED_VIEWS = [
  'front', 'back', 'left', 'right', 'top', 'bottom',
  'iso-ftr', 'iso-fbr', 'iso-ftl', 'iso-fbl',
  'iso-btr', 'iso-bbr', 'iso-btl', 'iso-bbl',
] as const;
export type NamedView = (typeof NAMED_VIEWS)[number];

export type ScreenshotView =
  | { kind: 'current' }
  | { kind: 'named'; name: NamedView }
  | { kind: 'orbit-from-current'; azimuthDeg: number; elevationDeg: number }
  | { kind: 'look-from'; eye: [number, number, number]; target?: [number, number, number] };

export type ImageResult = {
  image: { mimeType: string; base64: string };
};

export type ScreenshotInput = WorkspaceArg & {
  view?: ScreenshotView;
  width?: number;
  height?: number;
  showGrid?: boolean;
  showAxes?: boolean;
  transparent?: boolean;
  autoCrop?: boolean;
  fitToModel?: boolean;
  margin?: number;
};

export async function screenshot(input: ScreenshotInput): Promise<ToolResult<ImageResult>> {
  const validated = validateScreenshotInput(input);
  if (validated.ok === false) {
    return validated;
  }
  return runScreenshot(input, validated.data, /* multi */ false);
}

export type ScreenshotMultiInput = WorkspaceArg & {
  width?: number;
  height?: number;
  showGrid?: boolean;
  showAxes?: boolean;
  transparent?: boolean;
  margin?: number;
};

export async function screenshotMulti(
  input: ScreenshotMultiInput,
): Promise<ToolResult<ImageResult>> {
  const validated = validateScreenshotInput({ ...input, view: { kind: 'current' } });
  if (validated.ok === false) {
    return validated;
  }
  return runScreenshot(input, validated.data, /* multi */ true);
}

export type ScreenshotShapeInput = WorkspaceArg & {
  shapeId: string;
  margin?: number;
  width?: number;
  height?: number;
  showGrid?: boolean;
  showAxes?: boolean;
  transparent?: boolean;
};

export async function screenshotShape(
  input: ScreenshotShapeInput,
): Promise<ToolResult<ImageResult>> {
  if (!input?.shapeId || typeof input.shapeId !== 'string') {
    return err('invalid-input', '`shapeId` is required and must be a non-empty string.');
  }
  const margin = input.margin ?? 1.2;
  if (typeof margin !== 'number' || !Number.isFinite(margin) || margin <= 0) {
    return err('invalid-input', '`margin` must be a positive finite number when provided.');
  }

  const resolved = resolveClient(input);
  if (resolved.ok === false) {
    return resolved as ToolResult<ImageResult>;
  }
  const { client } = resolved.data;

  try {
    // Fetch the shape's bounding box so we can build an iso framing.
    const props = await client.getJson<any>(
      `/api/shape-properties?shapeId=${encodeURIComponent(input.shapeId)}`,
    );
    const bbox = extractBoundingBox(props);
    if (!bbox) {
      return err(
        'invalid-input',
        `Shape "${input.shapeId}" has no bounding box — cannot frame it.`,
        { properties: props },
      );
    }

    const cx = (bbox.min[0] + bbox.max[0]) / 2;
    const cy = (bbox.min[1] + bbox.max[1]) / 2;
    const cz = (bbox.min[2] + bbox.max[2]) / 2;
    const sx = bbox.max[0] - bbox.min[0];
    const sy = bbox.max[1] - bbox.min[1];
    const sz = bbox.max[2] - bbox.min[2];
    const diameter = Math.sqrt(sx * sx + sy * sy + sz * sz);
    const distance = Math.max(diameter * margin, 1);
    // Iso-ftr direction: (1, -1, 1) / sqrt(3).
    const k = distance / Math.sqrt(3);
    const view: ScreenshotView = {
      kind: 'look-from',
      eye: [cx + k, cy - k, cz + k],
      target: [cx, cy, cz],
    };

    const body: Record<string, unknown> = { view };
    if (input.width !== undefined) { body.width = input.width; }
    if (input.height !== undefined) { body.height = input.height; }
    if (input.showGrid !== undefined) { body.showGrid = input.showGrid; }
    if (input.showAxes !== undefined) { body.showAxes = input.showAxes; }
    if (input.transparent !== undefined) { body.transparent = input.transparent; }

    return await postScreenshot(client, body);
  } catch (e: any) {
    return wrapError<ImageResult>(e);
  } finally {
    await client.close().catch(() => {});
  }
}

export type CameraState = {
  position: [number, number, number];
  target: [number, number, number];
  up: [number, number, number];
  projection: 'orthographic' | 'perspective';
};

export async function getCameraState(input: WorkspaceArg): Promise<ToolResult<CameraState>> {
  const resolved = resolveClient(input);
  if (resolved.ok === false) {
    return resolved as ToolResult<CameraState>;
  }
  const { client } = resolved.data;
  try {
    const data = await client.getJson<any>('/api/camera/state');
    return ok({
      position: data.position,
      target: data.target,
      up: data.up,
      projection: data.projection,
    });
  } catch (e: any) {
    return wrapError<CameraState>(e);
  } finally {
    await client.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

type ValidatedOptions = {
  width?: number;
  height?: number;
  showGrid?: boolean;
  showAxes?: boolean;
  transparent?: boolean;
  autoCrop?: boolean;
  fitToModel?: boolean;
  margin?: number;
  view?: ScreenshotView;
};

function validateScreenshotInput(input: ScreenshotInput | ScreenshotMultiInput): ToolResult<ValidatedOptions> {
  const opts: ValidatedOptions = {};

  if ((input as ScreenshotInput).width !== undefined) {
    const w = (input as ScreenshotInput).width!;
    if (typeof w !== 'number' || !Number.isInteger(w) || w < 1 || w > 8192) {
      return err('invalid-input', '`width` must be an integer between 1 and 8192.');
    }
    opts.width = w;
  }
  if ((input as ScreenshotInput).height !== undefined) {
    const h = (input as ScreenshotInput).height!;
    if (typeof h !== 'number' || !Number.isInteger(h) || h < 1 || h > 8192) {
      return err('invalid-input', '`height` must be an integer between 1 and 8192.');
    }
    opts.height = h;
  }
  for (const k of ['showGrid', 'showAxes', 'transparent', 'autoCrop', 'fitToModel'] as const) {
    const v = (input as any)[k];
    if (v !== undefined) {
      if (typeof v !== 'boolean') {
        return err('invalid-input', `\`${k}\` must be a boolean when provided.`);
      }
      (opts as any)[k] = v;
    }
  }
  if ((input as ScreenshotInput).margin !== undefined) {
    const m = (input as ScreenshotInput).margin!;
    if (typeof m !== 'number' || !Number.isFinite(m) || m < 0) {
      return err('invalid-input', '`margin` must be a non-negative finite number.');
    }
    opts.margin = m;
  }

  const view = (input as ScreenshotInput).view;
  if (view !== undefined) {
    const validatedView = validateView(view);
    if (typeof validatedView === 'string') {
      return err('invalid-input', validatedView);
    }
    opts.view = validatedView;
  }

  return ok(opts);
}

function validateView(raw: unknown): ScreenshotView | string {
  if (raw === null || typeof raw !== 'object') {
    return '`view` must be an object.';
  }
  const v = raw as Record<string, unknown>;
  switch (v.kind) {
    case 'current':
      return { kind: 'current' };
    case 'named': {
      if (typeof v.name !== 'string' || !NAMED_VIEWS.includes(v.name as NamedView)) {
        return `\`view.name\` must be one of: ${NAMED_VIEWS.join(', ')}.`;
      }
      return { kind: 'named', name: v.name as NamedView };
    }
    case 'orbit-from-current': {
      if (typeof v.azimuthDeg !== 'number' || !Number.isFinite(v.azimuthDeg)) {
        return '`view.azimuthDeg` must be a finite number.';
      }
      if (typeof v.elevationDeg !== 'number' || !Number.isFinite(v.elevationDeg)) {
        return '`view.elevationDeg` must be a finite number.';
      }
      return { kind: 'orbit-from-current', azimuthDeg: v.azimuthDeg, elevationDeg: v.elevationDeg };
    }
    case 'look-from': {
      if (!isVec3(v.eye)) {
        return '`view.eye` must be a 3-element array of finite numbers.';
      }
      if (v.target !== undefined && !isVec3(v.target)) {
        return '`view.target` must be a 3-element array of finite numbers when provided.';
      }
      return {
        kind: 'look-from',
        eye: v.eye as [number, number, number],
        target: v.target as [number, number, number] | undefined,
      };
    }
    default:
      return '`view.kind` must be one of: current, named, orbit-from-current, look-from.';
  }
}

function isVec3(value: unknown): value is [number, number, number] {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every((n) => typeof n === 'number' && Number.isFinite(n))
  );
}

async function runScreenshot(
  input: WorkspaceArg,
  opts: ValidatedOptions,
  multi: boolean,
): Promise<ToolResult<ImageResult>> {
  const resolved = resolveClient(input);
  if (resolved.ok === false) {
    return resolved as ToolResult<ImageResult>;
  }
  const { client } = resolved.data;

  const body: Record<string, unknown> = { ...opts };
  if (multi) {
    body.multi = true;
  }

  try {
    return await postScreenshot(client, body);
  } catch (e: any) {
    return wrapError<ImageResult>(e);
  } finally {
    await client.close().catch(() => {});
  }
}

async function postScreenshot(
  client: FluidCadClient,
  body: Record<string, unknown>,
): Promise<ToolResult<ImageResult>> {
  const res = await client.postRaw('/api/screenshot', body);
  if (res.statusCode >= 400) {
    const text = res.data.toString('utf8');
    return err('http-error', `HTTP ${res.statusCode}: ${text.slice(0, 200)}`, {
      statusCode: res.statusCode,
    });
  }
  const mime = res.contentType.split(';')[0].trim() || 'image/png';
  return ok({
    image: {
      mimeType: mime,
      base64: res.data.toString('base64'),
    },
  });
}

function wrapError<T>(e: any): ToolResult<T> {
  if (e instanceof HttpError) {
    return err('http-error', `HTTP ${e.statusCode}: ${e.body.slice(0, 200)}`, {
      statusCode: e.statusCode,
    }) as ToolResult<T>;
  }
  return err('internal', e?.message ?? String(e)) as ToolResult<T>;
}

function extractBoundingBox(
  props: any,
): { min: [number, number, number]; max: [number, number, number] } | null {
  if (!props || typeof props !== 'object') {
    return null;
  }
  const bbox = props.boundingBox ?? props.bbox ?? null;
  if (!bbox || typeof bbox !== 'object') {
    return null;
  }
  const min = bbox.min;
  const max = bbox.max;
  const isTriple = (v: any) =>
    Array.isArray(v) && v.length === 3 && v.every((n: any) => typeof n === 'number' && Number.isFinite(n));
  if (isTriple(min) && isTriple(max)) {
    return { min: min as [number, number, number], max: max as [number, number, number] };
  }
  // Some payloads use `xMin/yMin/zMin` etc.
  const fields = ['xMin', 'yMin', 'zMin', 'xMax', 'yMax', 'zMax'];
  if (fields.every((f) => typeof bbox[f] === 'number')) {
    return {
      min: [bbox.xMin, bbox.yMin, bbox.zMin],
      max: [bbox.xMax, bbox.yMax, bbox.zMax],
    };
  }
  return null;
}

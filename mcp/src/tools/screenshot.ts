// Screenshot tools — render the running FluidCAD scene as a PNG and return
// MCP `image` content blocks. Views are stateless: the agent picks a vantage
// (named view, orbit-from-current, or look-from) and the user's interactive
// camera is never touched. Every tool takes the same overlay options —
// highlighted entities, hidden/focused shapes, labelled annotation lines,
// framing to the highlight and a section (cut-away) plane — which the
// server resolves and the page draws.

import { MeasureEntityInputs, resolveClient, type MeasureEntityInput, type WorkspaceArg } from './inspection.ts';
import { ScreenshotRequest, type ImageResult } from './screenshot-request.ts';
import { ScreenshotViews, type NamedView, type ScreenshotView } from './screenshot-views.ts';
import { ScreenshotSections, type SectionSpec } from './screenshot-section.ts';
import { err, ok, type ToolResult } from '../types.ts';

export type { ImageResult } from './screenshot-request.ts';
export type { NamedView, ScreenshotView } from './screenshot-views.ts';
export type { SectionSpec } from './screenshot-section.ts';
export { NAMED_VIEWS } from './screenshot-views.ts';
export { SECTION_PLANE_NAMES } from './screenshot-section.ts';

export type ScreenshotAnnotationInput = {
  from: [number, number, number];
  to: [number, number, number];
  label?: string;
};

/** The overlay options every screenshot tool accepts. */
export type ScreenshotOverlayInput = {
  highlight?: MeasureEntityInput[];
  hide?: string[];
  focus?: string[];
  annotations?: ScreenshotAnnotationInput[];
  fitTo?: 'highlight';
  section?: SectionSpec;
};

export type ScreenshotInput = WorkspaceArg & ScreenshotOverlayInput & {
  view?: ScreenshotView;
  width?: number;
  height?: number;
  showGrid?: boolean;
  showAxes?: boolean;
  transparent?: boolean;
  autoCrop?: boolean;
  fitToModel?: boolean;
  margin?: number;
  solidsOnly?: boolean;
  showDimensions?: boolean;
  showPositional?: boolean;
  framePlanes?: boolean;
  pixelRatio?: number;
};

export async function screenshot(input: ScreenshotInput): Promise<ToolResult<ImageResult>> {
  const validated = validateScreenshotInput(input);
  if (validated.ok === false) {
    return validated;
  }
  return runScreenshot(input, validated.data, /* multi */ false);
}

export type ScreenshotMultiInput = WorkspaceArg & ScreenshotOverlayInput & {
  views?: ScreenshotView[];
  width?: number;
  height?: number;
  showGrid?: boolean;
  showAxes?: boolean;
  transparent?: boolean;
  margin?: number;
  pixelRatio?: number;
};

export async function screenshotMulti(
  input: ScreenshotMultiInput,
): Promise<ToolResult<ImageResult>> {
  const validated = validateScreenshotInput({ ...input, view: { kind: 'current' } });
  if (validated.ok === false) {
    return validated;
  }
  const opts: ValidatedOptions = { ...validated.data };
  delete opts.view;
  if (input?.views !== undefined) {
    const views = ScreenshotViews.validateMany(input.views);
    if (typeof views === 'string') {
      return err('invalid-input', views);
    }
    opts.views = views;
  }
  return runScreenshot(input, opts, /* multi */ true);
}

export type ScreenshotShapeInput = WorkspaceArg & ScreenshotOverlayInput & {
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
  const overlays = ScreenshotOverlayInputs.validate(input);
  if (overlays.ok === false) {
    return overlays as ToolResult<ImageResult>;
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

    const body: Record<string, unknown> = { view, ...overlays.data };
    if (input.width !== undefined) { body.width = input.width; }
    if (input.height !== undefined) { body.height = input.height; }
    if (input.showGrid !== undefined) { body.showGrid = input.showGrid; }
    if (input.showAxes !== undefined) { body.showAxes = input.showAxes; }
    if (input.transparent !== undefined) { body.transparent = input.transparent; }

    return await ScreenshotRequest.post(client, body);
  } catch (e: any) {
    return ScreenshotRequest.wrapError<ImageResult>(e);
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
    return ScreenshotRequest.wrapError<CameraState>(e);
  } finally {
    await client.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Overlay input checks
// ---------------------------------------------------------------------------

export type ValidatedOverlays = {
  highlight?: MeasureEntityInput[];
  hide?: string[];
  focus?: string[];
  annotations?: ScreenshotAnnotationInput[];
  fitTo?: 'highlight';
  section?: SectionSpec;
};

/**
 * Input checks for the overlay options, mirroring the server's
 * ScreenshotRequests so a malformed request is refused here with the exact
 * field named. Highlight entities are the `measure` union — index refs or
 * filter expressions; the server resolves the expressions.
 */
export class ScreenshotOverlayInputs {

  static readonly MAX_HIGHLIGHT = 64;
  static readonly MAX_IDS = 64;
  static readonly MAX_ANNOTATIONS = 32;
  static readonly MAX_LABEL_LENGTH = 200;

  static validate(input: ScreenshotOverlayInput): ToolResult<ValidatedOverlays> {
    const out: ValidatedOverlays = {};
    const { highlight, hide, focus, annotations, fitTo, section } = input ?? {};

    if (hide !== undefined && focus !== undefined) {
      return err('invalid-input', '`hide` and `focus` are exclusive: pass one of them (hide removes shapes from the render, focus ghosts everything else).');
    }
    for (const [key, value] of [['hide', hide], ['focus', focus]] as const) {
      if (value === undefined) {
        continue;
      }
      const problem = ScreenshotOverlayInputs.idListError(value, key);
      if (problem) {
        return err('invalid-input', problem);
      }
      out[key] = value;
    }

    if (highlight !== undefined) {
      const problem = MeasureEntityInputs.error(highlight, { min: 1, max: ScreenshotOverlayInputs.MAX_HIGHLIGHT, label: 'highlight' });
      if (problem) {
        return err('invalid-input', problem);
      }
      out.highlight = highlight;
    }

    if (annotations !== undefined) {
      const problem = ScreenshotOverlayInputs.annotationsError(annotations);
      if (problem) {
        return err('invalid-input', problem);
      }
      out.annotations = annotations;
    }

    if (fitTo !== undefined) {
      if (fitTo !== 'highlight') {
        return err('invalid-input', '`fitTo` must be "highlight" when provided.');
      }
      if (!out.highlight) {
        return err('invalid-input', '`fitTo: "highlight"` needs a non-empty `highlight` to frame.');
      }
      out.fitTo = fitTo;
    }

    if (section !== undefined) {
      const parsed = ScreenshotSections.validate(section);
      if (typeof parsed === 'string') {
        return err('invalid-input', parsed);
      }
      out.section = parsed;
    }

    return ok(out);
  }

  private static idListError(value: unknown, label: string): string | null {
    if (!Array.isArray(value) || value.length < 1 || value.length > ScreenshotOverlayInputs.MAX_IDS) {
      return `\`${label}\` must be an array of 1-${ScreenshotOverlayInputs.MAX_IDS} shape or instance ids.`;
    }
    if (!value.every((id) => typeof id === 'string' && id.length > 0)) {
      return `\`${label}\` must contain non-empty string ids.`;
    }
    return null;
  }

  private static annotationsError(value: unknown): string | null {
    if (!Array.isArray(value) || value.length < 1 || value.length > ScreenshotOverlayInputs.MAX_ANNOTATIONS) {
      return `\`annotations\` must be an array of 1-${ScreenshotOverlayInputs.MAX_ANNOTATIONS} { from, to, label? } lines.`;
    }
    for (let i = 0; i < value.length; i++) {
      const a = value[i] as Record<string, unknown> | null;
      if (!a || typeof a !== 'object') {
        return `\`annotations[${i}]\` must be an object { from, to, label? }.`;
      }
      if (!ScreenshotViews.isVec3(a.from) || !ScreenshotViews.isVec3(a.to)) {
        return `\`annotations[${i}].from\` and \`.to\` must be 3-element arrays of finite numbers (document units).`;
      }
      if (a.label !== undefined && (typeof a.label !== 'string' || a.label.length > ScreenshotOverlayInputs.MAX_LABEL_LENGTH)) {
        return `\`annotations[${i}].label\` must be a string of at most ${ScreenshotOverlayInputs.MAX_LABEL_LENGTH} characters.`;
      }
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

type ValidatedOptions = ValidatedOverlays & {
  width?: number;
  height?: number;
  showGrid?: boolean;
  showAxes?: boolean;
  transparent?: boolean;
  autoCrop?: boolean;
  fitToModel?: boolean;
  margin?: number;
  view?: ScreenshotView;
  views?: ScreenshotView[];
  solidsOnly?: boolean;
  showDimensions?: boolean;
  showPositional?: boolean;
  framePlanes?: boolean;
  pixelRatio?: number;
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
  for (const k of ['showGrid', 'showAxes', 'transparent', 'autoCrop', 'fitToModel', 'solidsOnly', 'showDimensions', 'showPositional', 'framePlanes'] as const) {
    const v = (input as any)[k];
    if (v !== undefined) {
      if (typeof v !== 'boolean') {
        return err('invalid-input', `\`${k}\` must be a boolean when provided.`);
      }
      (opts as any)[k] = v;
    }
  }
  if ((input as ScreenshotInput).pixelRatio !== undefined) {
    const r = (input as ScreenshotInput).pixelRatio!;
    if (typeof r !== 'number' || !(r >= 1 && r <= 4)) {
      return err('invalid-input', '`pixelRatio` must be a number between 1 and 4.');
    }
    opts.pixelRatio = r;
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
    const validatedView = ScreenshotViews.validate(view);
    if (typeof validatedView === 'string') {
      return err('invalid-input', validatedView);
    }
    opts.view = validatedView;
  }

  const overlays = ScreenshotOverlayInputs.validate(input);
  if (overlays.ok === false) {
    return overlays as ToolResult<ValidatedOptions>;
  }
  Object.assign(opts, overlays.data);

  return ok(opts);
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
    return await ScreenshotRequest.post(client, body);
  } catch (e: any) {
    return ScreenshotRequest.wrapError<ImageResult>(e);
  } finally {
    await client.close().catch(() => {});
  }
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

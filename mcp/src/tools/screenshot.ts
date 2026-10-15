// Screenshot tools — render the running FluidCAD scene as a PNG and return
// MCP `image` content blocks. Views are stateless: the agent picks a vantage
// (named view, orbit-from-current, or look-from) and the user's interactive
// camera is never touched. Every tool takes the same overlay options —
// highlighted entities, hidden/focused shapes, labelled annotation lines,
// framing to the highlight or to given shapes, and a section (cut-away)
// plane — which the server resolves and the page draws.

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

/**
 * `fitTo: { shapes, margin? }` — frame these shape or instance ids as the page
 * draws them (instance poses included), nothing hidden or ghosted. `margin`
 * is the frame's size as a multiple of what the shapes cover on screen on the
 * tighter axis: 1 is flush with the frame edge, the page's default 1.2 leaves
 * a small margin.
 */
export type ScreenshotShapeFitInput = {
  shapes: string[];
  margin?: number;
};

/** The overlay options every screenshot tool accepts. */
export type ScreenshotOverlayInput = {
  highlight?: MeasureEntityInput[];
  hide?: string[];
  focus?: string[];
  annotations?: ScreenshotAnnotationInput[];
  fitTo?: 'highlight' | ScreenshotShapeFitInput;
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
  const opts: ValidatedOptions = { ...validated.data };
  // A section with no view asked for is looked at: the user's camera, or a
  // named view, as often as not faces the kept half and shows no cut at all.
  if (opts.section && opts.view === undefined) {
    opts.view = ScreenshotViews.SECTION_DEFAULT;
  }
  const problem = ScreenshotViews.sectionViewError(opts.view, undefined, opts.section !== undefined);
  if (problem) {
    return err('invalid-input', problem);
  }
  return runScreenshot(input, opts, /* multi */ false);
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
  } else if (opts.section) {
    // The default grid faces away from most cuts; a section is looked at
    // tilted and square-on instead.
    opts.views = ScreenshotViews.SECTION_DEFAULT_MULTI;
  }
  const problem = ScreenshotViews.sectionViewError(undefined, opts.views, opts.section !== undefined);
  if (problem) {
    return err('invalid-input', problem);
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

/**
 * A picture of one shape from the iso-ftr view, framed by the page as it
 * draws the shape — `fitTo: { shapes: [shapeId], margin }` — so an assembly
 * instance is framed where its pose puts it. The server refuses a shape id
 * the current render does not hold (404 `unknown-shape`).
 */
export async function screenshotShape(
  input: ScreenshotShapeInput,
): Promise<ToolResult<ImageResult>> {
  const request = ScreenshotShapeRequest.validate(input);
  if (request.ok === false) {
    return request as ToolResult<ImageResult>;
  }

  const resolved = resolveClient(input);
  if (resolved.ok === false) {
    return resolved as ToolResult<ImageResult>;
  }
  const { client } = resolved.data;

  try {
    return ScreenshotShapeRequest.explain(await ScreenshotRequest.post(client, request.data));
  } catch (e: any) {
    return ScreenshotShapeRequest.explain(ScreenshotRequest.wrapError<ImageResult>(e));
  } finally {
    await client.close().catch(() => {});
  }
}

/**
 * The `/api/screenshot` body `screenshot_shape` sends, and what its errors
 * mean. The caller's own `fitTo` wins over the shape framing; `margin` sizes
 * that framing only, so passing it beside a `fitTo` is refused rather than
 * silently dropped.
 */
export class ScreenshotShapeRequest {

  static readonly VIEW: ScreenshotView = { kind: 'named', name: 'iso-ftr' };
  /** An engine predating shape framing refuses any `fitTo` but "highlight" with this (inside a JSON body, so quotes may be escaped). */
  static readonly STALE_ENGINE = /fitTo must be \\?"highlight\\?" when provided/;

  static validate(input: ScreenshotShapeInput): ToolResult<Record<string, unknown>> {
    if (!input?.shapeId || typeof input.shapeId !== 'string') {
      return err('invalid-input', '`shapeId` is required and must be a non-empty string.');
    }
    if (input.margin !== undefined) {
      const problem = ScreenshotOverlayInputs.fitMarginError(input.margin, 'margin');
      if (problem) {
        return err('invalid-input', problem);
      }
      if (input.fitTo !== undefined) {
        return err('invalid-input', '`margin` sizes the framing of `shapeId`; with your own `fitTo` it has nothing to apply to. Drop one of them (a `fitTo: { shapes, margin }` carries its own margin).');
      }
    }
    const overlays = ScreenshotOverlayInputs.validate(input);
    if (overlays.ok === false) {
      return overlays as ToolResult<Record<string, unknown>>;
    }

    const fitTo = overlays.data.fitTo ?? {
      shapes: [input.shapeId],
      ...(input.margin !== undefined ? { margin: input.margin } : {}),
    };
    // A section is looked at instead of the iso vantage, which faces away
    // from most cuts; the shape framing still places the camera on the shape.
    const view: ScreenshotView = overlays.data.section ? ScreenshotViews.SECTION_DEFAULT : ScreenshotShapeRequest.VIEW;
    const body: Record<string, unknown> = { view, ...overlays.data, fitTo };
    if (input.width !== undefined) { body.width = input.width; }
    if (input.height !== undefined) { body.height = input.height; }
    if (input.showGrid !== undefined) { body.showGrid = input.showGrid; }
    if (input.showAxes !== undefined) { body.showAxes = input.showAxes; }
    if (input.transparent !== undefined) { body.transparent = input.transparent; }
    return ok(body);
  }

  /**
   * An engine older than shape framing refuses the `fitTo` object with its
   * "highlight only" message; say what that means instead of passing the
   * bare refusal on.
   */
  static explain(result: ToolResult<ImageResult>): ToolResult<ImageResult> {
    if (result.ok === false && result.code === 'http-error' && ScreenshotShapeRequest.STALE_ENGINE.test(result.message)) {
      return err(
        'http-error',
        `${result.message} — this FluidCAD engine predates shape framing (fitTo: { shapes }), which screenshot_shape needs; update the engine.`,
        result.details,
      );
    }
    return result;
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
  fitTo?: 'highlight' | ScreenshotShapeFitInput;
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
  /** A shape fit's margin range: 1 is flush with the frame edge. */
  static readonly MIN_FIT_MARGIN = 1;
  static readonly MAX_FIT_MARGIN = 10;

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
      if (fitTo === 'highlight') {
        if (!out.highlight) {
          return err('invalid-input', '`fitTo: "highlight"` needs a non-empty `highlight` to frame.');
        }
        out.fitTo = fitTo;
      } else {
        const problem = ScreenshotOverlayInputs.shapeFitError(fitTo);
        if (problem) {
          return err('invalid-input', problem);
        }
        out.fitTo = fitTo;
      }
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

  /** The problem with a shape-fit margin, or null when it is usable. */
  static fitMarginError(value: unknown, label: string): string | null {
    const inRange = typeof value === 'number'
      && value >= ScreenshotOverlayInputs.MIN_FIT_MARGIN
      && value <= ScreenshotOverlayInputs.MAX_FIT_MARGIN;
    if (!inRange) {
      return `\`${label}\` must be a number between ${ScreenshotOverlayInputs.MIN_FIT_MARGIN} and ${ScreenshotOverlayInputs.MAX_FIT_MARGIN} (1 frames the shape flush with the frame edge, 1.2 leaves a small margin).`;
    }
    return null;
  }

  private static shapeFitError(value: unknown): string | null {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return '`fitTo` must be "highlight" or { shapes: [...ids], margin? } when provided.';
    }
    const { shapes, margin } = value as Record<string, unknown>;
    const problem = ScreenshotOverlayInputs.idListError(shapes, 'fitTo.shapes');
    if (problem) {
      return problem;
    }
    if (margin !== undefined) {
      return ScreenshotOverlayInputs.fitMarginError(margin, 'fitTo.margin');
    }
    return null;
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

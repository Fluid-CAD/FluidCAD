import type { NamedView, ScreenshotAnnotation, ScreenshotHighlightRef, ScreenshotView, SectionSpec } from '../ws-protocol.ts';
import { MeasureEntityResolver, type MeasureEntity } from '../measure-entities.ts';
import { SelectionRequests } from './selection-requests.ts';
import { SectionRequests } from './screenshot-section.ts';

const NAMED_VIEWS: ReadonlySet<NamedView> = new Set([
  'front', 'back', 'left', 'right', 'top', 'bottom',
  'iso-ftr', 'iso-fbr', 'iso-ftl', 'iso-fbl',
  'iso-btr', 'iso-bbr', 'iso-btl', 'iso-bbl',
]);

/** The resolver a highlight's filter entities go through — `FluidCadServer.resolveSelection`. */
export type ScreenshotSelectionResolver = Parameters<typeof MeasureEntityResolver.resolveMany>[1];

/** The overlay options a validated request carries to the page, already resolved to index refs. */
export type ScreenshotOverlayOptions = {
  highlight?: ScreenshotHighlightRef[];
  hide?: string[];
  focus?: string[];
  annotations?: ScreenshotAnnotation[];
  fitTo?: 'highlight';
  views?: ScreenshotView[];
  section?: SectionSpec;
};

export type ScreenshotOverlayValidation =
  | { ok: true; options: ScreenshotOverlayOptions }
  | { ok: false; status: number; error: string; code?: string; candidates?: unknown[] };

/**
 * Body validation for `/screenshot`'s view, overlay and section fields. Highlight
 * entities take the same union `/measure` accepts — index refs or filter
 * expressions — and filters are resolved here, every match kept, so the page
 * only ever sees concrete `{ shapeId, kind, index, instanceId? }` refs; an
 * expression matching nothing is refused the way `/measure` refuses it.
 */
export class ScreenshotRequests {

  static readonly MAX_HIGHLIGHT = 64;
  static readonly MAX_IDS = 64;
  static readonly MAX_ANNOTATIONS = 32;
  static readonly MAX_LABEL_LENGTH = 200;
  static readonly MIN_VIEWS = 2;
  static readonly MAX_VIEWS = 6;

  /** Validate a `view` payload. Returns the parsed view on success or an error-message string on failure. */
  static view(raw: unknown, label = 'view'): ScreenshotView | string {
    if (raw === null || typeof raw !== 'object') {
      return `${label} must be an object.`;
    }
    const v = raw as Record<string, unknown>;
    switch (v.kind) {
      case 'current':
        return { kind: 'current' };
      case 'named': {
        if (typeof v.name !== 'string' || !NAMED_VIEWS.has(v.name as NamedView)) {
          return `${label}.name must be one of: ${Array.from(NAMED_VIEWS).join(', ')}.`;
        }
        return { kind: 'named', name: v.name as NamedView };
      }
      case 'orbit-from-current': {
        if (typeof v.azimuthDeg !== 'number' || !Number.isFinite(v.azimuthDeg)) {
          return `${label}.azimuthDeg must be a finite number.`;
        }
        if (typeof v.elevationDeg !== 'number' || !Number.isFinite(v.elevationDeg)) {
          return `${label}.elevationDeg must be a finite number.`;
        }
        return { kind: 'orbit-from-current', azimuthDeg: v.azimuthDeg, elevationDeg: v.elevationDeg };
      }
      case 'look-from': {
        if (!ScreenshotRequests.isVec3(v.eye)) {
          return `${label}.eye must be a 3-element array of finite numbers.`;
        }
        if (v.target !== undefined && !ScreenshotRequests.isVec3(v.target)) {
          return `${label}.target must be a 3-element array of finite numbers when provided.`;
        }
        return {
          kind: 'look-from',
          eye: v.eye as [number, number, number],
          target: v.target as [number, number, number] | undefined,
        };
      }
      default:
        return `${label}.kind must be one of: current, named, orbit-from-current, look-from.`;
    }
  }

  /** Validate and resolve the overlay fields of a `/screenshot` body. */
  static overlays(body: Record<string, unknown>, resolveSelection: ScreenshotSelectionResolver | undefined): ScreenshotOverlayValidation {
    const options: ScreenshotOverlayOptions = {};
    const { highlight, hide, focus, annotations, fitTo, views, multi, section } = body;

    if (hide !== undefined && focus !== undefined) {
      return ScreenshotRequests.refuse(400, 'hide and focus are exclusive: pass one of them (hide removes shapes from the render, focus ghosts everything else).');
    }
    for (const [key, value] of [['hide', hide], ['focus', focus]] as const) {
      if (value === undefined) {
        continue;
      }
      const problem = ScreenshotRequests.idListError(value, key);
      if (problem) {
        return ScreenshotRequests.refuse(400, problem);
      }
      options[key] = value as string[];
    }

    if (highlight !== undefined) {
      const resolved = ScreenshotRequests.highlight(highlight, resolveSelection);
      if (resolved.ok === false) {
        return resolved;
      }
      options.highlight = resolved.options.highlight;
    }

    if (annotations !== undefined) {
      const problem = ScreenshotRequests.annotationsError(annotations);
      if (problem) {
        return ScreenshotRequests.refuse(400, problem);
      }
      options.annotations = (annotations as Array<Record<string, unknown>>).map(a => ({
        from: a.from as [number, number, number],
        to: a.to as [number, number, number],
        ...(a.label !== undefined ? { label: a.label as string } : {}),
      }));
    }

    if (fitTo !== undefined) {
      if (fitTo !== 'highlight') {
        return ScreenshotRequests.refuse(400, 'fitTo must be "highlight" when provided.');
      }
      if (!options.highlight || options.highlight.length === 0) {
        return ScreenshotRequests.refuse(400, 'fitTo: "highlight" needs a non-empty highlight to frame.');
      }
      options.fitTo = 'highlight';
    }

    if (views !== undefined) {
      if (multi !== true) {
        return ScreenshotRequests.refuse(400, 'views applies to multi-view captures only: pass multi: true with it.');
      }
      const parsed = ScreenshotRequests.views(views);
      if (typeof parsed === 'string') {
        return ScreenshotRequests.refuse(400, parsed);
      }
      options.views = parsed;
    }

    if (section !== undefined) {
      const parsed = SectionRequests.validate(section);
      if (typeof parsed === 'string') {
        return ScreenshotRequests.refuse(400, parsed);
      }
      options.section = parsed;
    }

    return { ok: true, options };
  }

  static views(raw: unknown): ScreenshotView[] | string {
    if (!Array.isArray(raw) || raw.length < ScreenshotRequests.MIN_VIEWS || raw.length > ScreenshotRequests.MAX_VIEWS) {
      return `views must be an array of ${ScreenshotRequests.MIN_VIEWS}-${ScreenshotRequests.MAX_VIEWS} views.`;
    }
    const parsed: ScreenshotView[] = [];
    for (let i = 0; i < raw.length; i++) {
      const view = ScreenshotRequests.view(raw[i], `views[${i}]`);
      if (typeof view === 'string') {
        return view;
      }
      parsed.push(view);
    }
    return parsed;
  }

  private static highlight(raw: unknown, resolveSelection: ScreenshotSelectionResolver | undefined): ScreenshotOverlayValidation {
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > ScreenshotRequests.MAX_HIGHLIGHT) {
      return ScreenshotRequests.refuse(400, `highlight must be an array of 1-${ScreenshotRequests.MAX_HIGHLIGHT} face/edge references or filter expressions.`);
    }
    for (let i = 0; i < raw.length; i++) {
      const problem = ScreenshotRequests.entityError(raw[i], `highlight[${i}]`);
      if (problem) {
        return ScreenshotRequests.refuse(400, problem);
      }
    }
    const entities = raw as MeasureEntity[];
    if (!entities.some(MeasureEntityResolver.isFilterEntity)) {
      return { ok: true, options: { highlight: entities.map(ScreenshotRequests.stripPose) } };
    }
    if (!resolveSelection) {
      return ScreenshotRequests.refuse(501, 'highlight expressions cannot be resolved on this server.');
    }
    const resolved = MeasureEntityResolver.resolveMany(entities, resolveSelection, 'highlight');
    if (resolved.ok === false) {
      return {
        ok: false,
        status: SelectionRequests.statusFor(resolved.code),
        error: resolved.error,
        code: resolved.code,
        ...(resolved.candidates ? { candidates: resolved.candidates } : {}),
      };
    }
    return { ok: true, options: { highlight: resolved.refs.map(ScreenshotRequests.stripPose) } };
  }

  /** The page looks entities up in the live scene graph; a pose has no meaning for it. */
  private static stripPose(ref: MeasureEntity): ScreenshotHighlightRef {
    const { shapeId, kind, index, instanceId } = ref as ScreenshotHighlightRef;
    return { shapeId, kind, index, ...(instanceId !== undefined ? { instanceId } : {}) };
  }

  private static entityError(entity: unknown, label: string): string | null {
    if (MeasureEntityResolver.isFilterEntity(entity)) {
      return SelectionRequests.expressionError(entity.expression, `${label}.expression`)
        ?? SelectionRequests.scopeError(entity.scope, `${label}.scope`);
    }
    const e = entity as Record<string, unknown> | null;
    const validKind = e?.kind === 'face' || e?.kind === 'edge';
    const validIndex = Number.isInteger(e?.index) && (e!.index as number) >= 0;
    if (!e || typeof e.shapeId !== 'string' || !e.shapeId || !validKind || !validIndex) {
      return `${label} needs a shapeId, a kind (face|edge) and a non-negative index, or an expression (with optional scope).`;
    }
    if (e.instanceId !== undefined && (typeof e.instanceId !== 'string' || !e.instanceId)) {
      return `${label}.instanceId must be a non-empty string.`;
    }
    return null;
  }

  private static idListError(value: unknown, label: string): string | null {
    if (!Array.isArray(value) || value.length < 1 || value.length > ScreenshotRequests.MAX_IDS) {
      return `${label} must be an array of 1-${ScreenshotRequests.MAX_IDS} shape or instance ids.`;
    }
    if (!value.every(id => typeof id === 'string' && id.length > 0)) {
      return `${label} must contain non-empty string ids.`;
    }
    return null;
  }

  private static annotationsError(value: unknown): string | null {
    if (!Array.isArray(value) || value.length < 1 || value.length > ScreenshotRequests.MAX_ANNOTATIONS) {
      return `annotations must be an array of 1-${ScreenshotRequests.MAX_ANNOTATIONS} { from, to, label? } lines.`;
    }
    for (let i = 0; i < value.length; i++) {
      const a = value[i] as Record<string, unknown> | null;
      if (!a || typeof a !== 'object') {
        return `annotations[${i}] must be an object { from, to, label? }.`;
      }
      if (!ScreenshotRequests.isVec3(a.from) || !ScreenshotRequests.isVec3(a.to)) {
        return `annotations[${i}].from and .to must be 3-element arrays of finite numbers (document units).`;
      }
      if (a.label !== undefined && (typeof a.label !== 'string' || a.label.length > ScreenshotRequests.MAX_LABEL_LENGTH)) {
        return `annotations[${i}].label must be a string of at most ${ScreenshotRequests.MAX_LABEL_LENGTH} characters.`;
      }
    }
    return null;
  }

  private static refuse(status: number, error: string): ScreenshotOverlayValidation {
    return { ok: false, status, error };
  }

  private static isVec3(value: unknown): value is [number, number, number] {
    return (
      Array.isArray(value) &&
      value.length === 3 &&
      value.every((n) => typeof n === 'number' && Number.isFinite(n))
    );
  }
}

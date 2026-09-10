// `measure`'s optional picture: the measured entities highlighted, the two
// realizing points of the primary value joined by a line labelled with that
// value and the unit, framed to the entities. Pure — builds the screenshot
// body from a measure payload; the caller posts it.

import { err, ok, type ToolResult } from '../types.ts';
import type { ScreenshotView } from './screenshot.ts';
import { ScreenshotSections, type SectionSpec } from './screenshot-section.ts';

export type MeasureImageInput = {
  view?: ScreenshotView;
  width?: number;
  height?: number;
  pixelRatio?: number;
  /** Cut the model away on one side of a plane so an internal measurement (a bore depth, a wall) is seen in section. */
  section?: SectionSpec;
};

type Vec = { x: number; y: number; z: number };
type DistanceValue = { value: number; from: Vec; to: Vec };
type MeasuredEntity = { ref: { shapeId: string; kind: 'face' | 'edge'; index: number; instanceId?: string } };

export type HighlightRef = { shapeId: string; kind: 'face' | 'edge'; index: number; instanceId?: string };
export type Annotation = { from: [number, number, number]; to: [number, number, number]; label?: string };

export class MeasureImage {

  static readonly LENGTH_DECIMALS = 3;
  static readonly ANGLE_DECIMALS = 2;

  /** Input checks for `image`; the view itself is checked by the caller's view validator. */
  static validate(image: unknown, validateView: (view: unknown) => ScreenshotView | string): ToolResult<MeasureImageInput> {
    if (image === undefined) {
      return ok({});
    }
    if (image === null || typeof image !== 'object' || Array.isArray(image)) {
      return err('invalid-input', '`image` must be an object { view?, width?, height?, pixelRatio?, section? }.');
    }
    const input = image as Record<string, unknown>;
    const out: MeasureImageInput = {};
    for (const key of ['width', 'height'] as const) {
      const value = input[key];
      if (value !== undefined) {
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 8192) {
          return err('invalid-input', `\`image.${key}\` must be an integer between 1 and 8192.`);
        }
        out[key] = value;
      }
    }
    if (input.pixelRatio !== undefined) {
      const ratio = input.pixelRatio;
      if (typeof ratio !== 'number' || !(ratio >= 1 && ratio <= 4)) {
        return err('invalid-input', '`image.pixelRatio` must be a number between 1 and 4.');
      }
      out.pixelRatio = ratio;
    }
    if (input.view !== undefined) {
      const view = validateView(input.view);
      if (typeof view === 'string') {
        return err('invalid-input', view.replace('`view', '`image.view'));
      }
      out.view = view;
    }
    if (input.section !== undefined) {
      const section = ScreenshotSections.validate(input.section, '`image.section`');
      if (typeof section === 'string') {
        return err('invalid-input', section);
      }
      out.section = section;
    }
    return ok(out);
  }

  /**
   * The `/api/screenshot` body for a measurement: every measured entity
   * highlighted, one labelled line for a two-entity measurement, framed to
   * the highlight. `view` defaults to iso-ftr so the picture is a known
   * vantage rather than wherever the user's camera happens to be; `section`
   * is passed through so an internal measurement is seen in section.
   */
  static screenshotBody(measured: Record<string, any>, image: MeasureImageInput): Record<string, unknown> {
    const entities: MeasuredEntity[] = Array.isArray(measured.entities) ? measured.entities : [];
    const highlight = entities
      .filter(e => e?.ref && typeof e.ref.shapeId === 'string')
      .map(e => MeasureImage.highlightRef(e));
    const body: Record<string, unknown> = {
      view: image.view ?? { kind: 'named', name: 'iso-ftr' },
      fitTo: 'highlight',
    };
    if (highlight.length > 0) {
      body.highlight = highlight;
    } else {
      delete body.fitTo;
    }
    const annotation = MeasureImage.annotation(measured, entities.length);
    if (annotation) {
      body.annotations = [annotation];
    }
    for (const key of ['width', 'height', 'pixelRatio', 'section'] as const) {
      if (image[key] !== undefined) {
        body[key] = image[key];
      }
    }
    return body;
  }

  /**
   * The line a two-entity measurement draws: the realizing points of the
   * primary value when it is a distance, else those of the minimum distance
   * (an angle has no points of its own) labelled with the angle.
   */
  static annotation(measured: Record<string, any>, entityCount: number): Annotation | null {
    if (entityCount !== 2) {
      return null;
    }
    const primary = typeof measured.primary === 'string' ? measured.primary : '';
    const unit = typeof measured.unit === 'string' ? measured.unit : '';
    const distance = MeasureImage.distanceValue(measured[primary]);
    if (distance) {
      return {
        from: MeasureImage.triple(distance.from),
        to: MeasureImage.triple(distance.to),
        label: `${MeasureImage.formatLength(distance.value)}${unit ? ` ${unit}` : ''}`,
      };
    }
    const fallback = MeasureImage.distanceValue(measured.minDist);
    if (!fallback) {
      return null;
    }
    const label = primary === 'angle' && typeof measured.angleDeg === 'number'
      ? `${MeasureImage.formatAngle(measured.angleDeg)}°`
      : `${MeasureImage.formatLength(fallback.value)}${unit ? ` ${unit}` : ''}`;
    return { from: MeasureImage.triple(fallback.from), to: MeasureImage.triple(fallback.to), label };
  }

  static formatLength(value: number): string {
    return MeasureImage.trimZeros(value.toFixed(MeasureImage.LENGTH_DECIMALS));
  }

  static formatAngle(value: number): string {
    return MeasureImage.trimZeros(value.toFixed(MeasureImage.ANGLE_DECIMALS));
  }

  private static highlightRef(entity: MeasuredEntity): HighlightRef {
    const { shapeId, kind, index, instanceId } = entity.ref;
    return { shapeId, kind, index, ...(instanceId !== undefined ? { instanceId } : {}) };
  }

  private static distanceValue(value: unknown): DistanceValue | null {
    if (!value || typeof value !== 'object') {
      return null;
    }
    const d = value as Partial<DistanceValue>;
    if (typeof d.value !== 'number' || !MeasureImage.isVec(d.from) || !MeasureImage.isVec(d.to)) {
      return null;
    }
    return d as DistanceValue;
  }

  private static isVec(v: unknown): v is Vec {
    return !!v && typeof v === 'object' && ['x', 'y', 'z'].every(k => Number.isFinite((v as Record<string, unknown>)[k]));
  }

  private static triple(v: Vec): [number, number, number] {
    return [v.x, v.y, v.z];
  }

  private static trimZeros(text: string): string {
    return text.includes('.') ? text.replace(/\.?0+$/, '') : text;
  }
}

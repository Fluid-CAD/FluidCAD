// The spur fixture: a gear-like feature for generated parts (definePart) and
// named frames. Its body is a plain disc of the gear's tip diameter, `width`
// deep, standing on an optional location — a connector, a point or an
// anchor — or, with none, on the XY plane at the origin; its `axis` frame
// sits at the disc's centre on the plane it stands on, Z along its axis, as
// the gears package's gear stands on its `at`. Its dialog borrows the shape
// of the real gear's: a Placement section about the pick, size rows, and a
// style select with pictures. Written against the SDK entry points only,
// with Feature.with() and defineFeature().

import { Feature, defineFeature, type FeatureArgs, type FeatureWith, type ValuesOf } from "../../../sdk/index.js";
import { Primitives, ShapeOps, type Shape } from "../../../sdk/kernel.js";
import { Matrix4, Plane } from "../../../math/index.js";

export const SPUR_DEFAULTS = { teeth: 24, module: 2, width: 10, style: 'spur' } as const;

/** The spur's values, as `Feature.with()` declares them: one optional pick, then four typed-in values. */
export const SPUR_PARAMS = {
  at: {
    picker: ['connector', 'point', 'anchor'], optional: true, label: 'At',
    description: 'Where the gear stands; left empty, on the XY plane at the origin',
  },
  teeth: { type: 'integer', default: SPUR_DEFAULTS.teeth, min: 4, max: 400, description: 'The number of teeth round the gear' },
  module: { type: 'length', default: SPUR_DEFAULTS.module, min: 0.1, description: 'The tooth size' },
  width: { type: 'length', default: SPUR_DEFAULTS.width, min: 0.01, label: 'Face width' },
  style: {
    type: 'select', default: SPUR_DEFAULTS.style, label: 'Style', display: 'grid', columns: 2,
    options: [
      { label: 'Spur', value: 'spur', image: './img/spur.png' },
      { label: 'Helical', value: 'helical', image: './img/helical.png' },
    ],
  },
} as const;

/** The spur's frames: its axis, which a generated part makes a connector. */
export const SPUR_FRAMES = { axis: { label: 'Gear axis' } } as const;

/** The spur dialog's rows: the pick in a section of its own, then the size. */
export const SPUR_LAYOUT = [
  { section: 'Placement', items: ['at', { note: 'Pick where the gear stands' }] },
  { note: 'Standing at the origin', visibleWhen: { at: { picked: false } } },
  { section: 'Size', items: [{ row: ['teeth', 'module'] }, 'width'] },
  'style',
] as const;

const SPUR_CALL = ['at', { teeth: 'teeth', module: 'module', width: 'width', style: 'style' }] as const;

export type SpurValues = ValuesOf<typeof SPUR_PARAMS>;

export type SpurFeature = InstanceType<FeatureWith<typeof SPUR_PARAMS, {}, typeof SPUR_FRAMES>>;

export type SpurFunction = (...args: FeatureArgs<typeof SPUR_PARAMS, typeof SPUR_CALL>) => SpurFeature;

/** The spur class: what `definePart()` takes. */
export type SpurClass = FeatureWith<typeof SPUR_PARAMS, {}, typeof SPUR_FRAMES> & { readonly id: string };

/** The tip radius of a spur of `teeth` teeth of `module`: the disc the fixture builds. */
export function spurRadius(teeth: number, module: number): number {
  return (module * teeth) / 2 + module;
}

/**
 * The spur class and its builder, made anew on every call — a workspace
 * module is evaluated again on every render, so its class is a new class
 * each time. `registered: false` leaves the builder out, so no metadata
 * tells the class its dialog.
 */
export function defineSpur(variant: { registered?: boolean } = {}): { Spur: SpurClass; spur: SpurFunction } {
  class Spur extends Feature.with(SPUR_PARAMS, { frames: SPUR_FRAMES }) {
    static id = 'acme.spur';

    buildTool(): Shape[] {
      const { at, teeth, module, width } = this.values;
      const frame = at ? this.frameOf(at) : Plane.XY();
      const disc = Primitives.makeCylinder(spurRadius(teeth, module), width);
      const placed = ShapeOps.transform(disc, Matrix4.fromBasis(frame.xDirection, frame.yDirection, frame.normal, frame.origin));
      disc.dispose();
      this.setFrames({ axis: frame });
      return [placed];
    }
  }
  const spur = variant.registered === false
    ? (null as unknown as SpurFunction)
    : defineFeature(Spur, {
      label: 'Spur gear', group: 'create', operations: ['add', 'new'], width: 'wide',
      aside: [{ image: './img/spur-dims.svg', alt: 'The spur gear' }],
      layout: SPUR_LAYOUT,
      call: SPUR_CALL,
    }) as unknown as SpurFunction;
  return { Spur, spur };
}

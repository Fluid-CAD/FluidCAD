// The standoff fixture, TypeScript copy: a PCB standoff — a cylinder boss
// with a bore through it — standing on a picked planar face. Written the way
// a project's standoff.feature.js is, against the SDK entry points only.

import { Feature, registerBuilder, type ISceneObject, type SceneParserContext } from "../../../sdk/index.js";
import { BooleanOps, Primitives, ShapeOps, type Face, type Shape } from "../../../sdk/kernel.js";
import { Matrix4, Plane } from "../../../math/index.js";

export type StandoffValues = {
  /** The planar face the standoff stands on, at its centre. */
  face: ISceneObject;
  height: number;
  /** The boss diameter. */
  outer: number;
  /** The bore diameter. */
  hole: number;
};

export type StandoffOptions = Partial<Omit<StandoffValues, 'face'>>;

export type StandoffFunction = (face: ISceneObject, options?: StandoffOptions) => StandoffFeature;

export type StandoffFeature = Feature<StandoffValues>;

export type StandoffClass = new (values: StandoffValues) => StandoffFeature;

export const STANDOFF_DEFAULTS = { height: 10, outer: 6, hole: 3 };

/**
 * The standoff class and its builder, made anew on every call. A workspace
 * module is evaluated again on every render, so its feature class is a new
 * class each time; a test calls this twice to do the same.
 */
export function defineStandoff(): { Standoff: StandoffClass; standoff: StandoffFunction } {
  class Standoff extends Feature<StandoffValues> {
    static id = 'acme.standoff';

    buildTool(): Shape[] {
      const { height, outer, hole } = this.values;
      if (!(hole < outer)) {
        throw new Error(`standoff: the hole (${hole}) must be narrower than the boss (${outer})`);
      }
      const faces = this.facesOf(this.values.face);
      if (faces.length !== 1) {
        throw new Error(`standoff: pick one planar face to stand on (got ${faces.length} faces)`);
      }
      const plane = faces[0].getPlane();
      const origin = plane.projectPoint(faces[0].center());

      // Built standing on the XY plane, classified there, then placed.
      const boss = Primitives.makeCylinder(outer / 2, height);
      const bore = Primitives.makeCylinder(hole / 2, height);
      const tube = BooleanOps.cutShapes(boss, bore);
      boss.dispose();
      bore.dispose();

      const tolerance = 1e-6 * Math.max(height, outer);
      const all = tube.getSubShapes('face') as Face[];
      const start = all.filter(f => Math.abs(f.getBoundingBox().maxZ) < tolerance);
      const end = all.filter(f => Math.abs(f.getBoundingBox().minZ - height) < tolerance);
      const walls = all.filter(f => !start.includes(f) && !end.includes(f));
      const side = walls.filter(f => f.getBoundingBox().maxX > hole / 2 + tolerance);
      const internal = walls.filter(f => !side.includes(f));

      const frame = Matrix4.fromBasis(plane.xDirection, plane.yDirection, plane.normal, origin);
      const members = [...start, ...end, ...side, ...internal];
      const placed = ShapeOps.transformTracking(tube, frame, members);
      tube.dispose();
      const image = (faces: Face[]) => faces.map(f => placed.images[members.indexOf(f)] as Face);

      this.setBuckets({
        startFaces: image(start),
        endFaces: image(end),
        sideFaces: image(side),
        internalFaces: image(internal),
        startPlane: new Plane(origin, plane.xDirection, plane.normal),
      });
      return [placed.shape];
    }
  }

  const standoff = registerBuilder((context: SceneParserContext) =>
    (face: ISceneObject, options: StandoffOptions = {}) =>
      new Standoff({ face, ...STANDOFF_DEFAULTS, ...options }).addTo(context));

  return { Standoff, standoff };
}

export const { Standoff, standoff } = defineStandoff();

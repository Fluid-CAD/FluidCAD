import type { TopoDS_Shape } from "ocjs-fluidcad";
import { getOC } from "./init.js";
import type { Shape } from "../common/shape.js";
import { ShapeOps } from "./shape-ops.js";

/** A solid's mass properties, what a part's totals add up. */
export interface SolidProperties {
  volumeMm3: number;
  surfaceAreaMm2: number;
  centroid: { x: number; y: number; z: number };
}

/** What a rendered shape is, in the words a user reads. */
export type MeasuredShapeKind = 'solid' | 'surface' | 'face' | 'curve' | 'vertex';

/**
 * One rendered shape's properties, by what it is: a solid has a volume and
 * an area, a surface or a lone face an area and no volume, a curve a length.
 * The centroid is the centre of mass of that measure — of the volume, the
 * area or the length — and the box bounds the geometry exactly.
 */
export interface ShapeProperties {
  kind: MeasuredShapeKind;
  /** Solids only. */
  volumeMm3?: number;
  /** Solids, surfaces and faces. */
  surfaceAreaMm2?: number;
  /** Curves only. */
  length?: number;
  centroid: { x: number; y: number; z: number };
  boundingBox: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } };
}

/**
 * The surface or the curve a picked face or edge belongs to, measured whole:
 * a surface's area, a curve's length. A solid's faces and edges carry none —
 * they are read on their own.
 */
export type OwnerMeasure = { kind: 'surface'; area: number } | { kind: 'curve'; length: number };

export class ShapeProps {
  /** {@link OwnerMeasure} of the shape a face or an edge was picked on; undefined for a solid or anything else. */
  static ownerMeasure(owner: Shape): OwnerMeasure | undefined {
    if (owner.isSolid()) {
      return undefined;
    }
    if (owner.isBody()) {
      return { kind: 'surface', area: ShapeProps.massOf(owner.getShape(), 'surface').mass };
    }
    if (owner.isEdge() || owner.isWire()) {
      return { kind: 'curve', length: ShapeProps.massOf(owner.getShape(), 'linear').mass };
    }
    return undefined;
  }

  /** The properties of a rendered shape, measured as what it is (see {@link ShapeProperties}). */
  static measure(shape: Shape): ShapeProperties {
    const raw = shape.getShape();
    const box = ShapeOps.getExactBoundingBoxRaw(raw);
    const boundingBox = {
      min: { x: box.minX, y: box.minY, z: box.minZ },
      max: { x: box.maxX, y: box.maxY, z: box.maxZ },
    };
    if (shape.isSolid()) {
      return { kind: 'solid', ...ShapeProps.getProperties(raw), boundingBox };
    }
    if (shape.isBody() || shape.isFace()) {
      const { mass, centroid } = ShapeProps.massOf(raw, 'surface');
      return { kind: shape.isBody() ? 'surface' : 'face', surfaceAreaMm2: mass, centroid, boundingBox };
    }
    if (shape.isEdge() || shape.isWire()) {
      const { mass, centroid } = ShapeProps.massOf(raw, 'linear');
      return { kind: 'curve', length: mass, centroid, boundingBox };
    }
    const centre = { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2, z: (box.minZ + box.maxZ) / 2 };
    return { kind: 'vertex', centroid: centre, boundingBox };
  }

  private static massOf(shape: TopoDS_Shape, measure: 'surface' | 'linear'): { mass: number; centroid: { x: number; y: number; z: number } } {
    const oc = getOC();
    const props = new oc.GProp_GProps();
    try {
      if (measure === 'surface') {
        oc.BRepGProp.SurfaceProperties(shape, props, false, false);
      } else {
        oc.BRepGProp.LinearProperties(shape, props, false, false);
      }
      const cog = props.CentreOfMass();
      const centroid = { x: cog.X(), y: cog.Y(), z: cog.Z() };
      cog.delete();
      return { mass: props.Mass(), centroid };
    } finally {
      props.delete();
    }
  }

  static getProperties(shape: TopoDS_Shape): SolidProperties {
    const oc = getOC();

    const volumeProps = new oc.GProp_GProps();
    // Eps-driven adaptive integration: the default fixed-order quadrature
    // under-integrates faces trimmed by fitted B-spline pcurves (seen with
    // wrap() pads — ~7% volume error) while this overload stays exact.
    oc.BRepGProp.VolumeProperties(shape, volumeProps, 1e-6, false, false);
    const volumeMm3 = volumeProps.Mass();
    const cog = volumeProps.CentreOfMass();
    const centroid = { x: cog.X(), y: cog.Y(), z: cog.Z() };
    cog.delete();
    volumeProps.delete();

    const surfaceProps = new oc.GProp_GProps();
    oc.BRepGProp.SurfaceProperties(shape, surfaceProps, false, false);
    const surfaceAreaMm2 = surfaceProps.Mass();
    surfaceProps.delete();

    return { volumeMm3, surfaceAreaMm2, centroid };
  }

  /**
   * Volume and centre of mass by the kernel's fixed-order quadrature — several
   * times cheaper than {@link getProperties}' adaptive pass, and less exact on
   * the faces that pass exists for. It integrates the same geometry to the
   * same number every time, which is all telling two bodies apart needs; a
   * number shown to the user wants `getProperties`.
   */
  static getVolumeAndCentroid(shape: TopoDS_Shape): { volume: number; centroid: { x: number; y: number; z: number } } {
    const oc = getOC();
    const props = new oc.GProp_GProps();
    try {
      oc.BRepGProp.VolumeProperties(shape, props, false, false, false);
      const cog = props.CentreOfMass();
      const centroid = { x: cog.X(), y: cog.Y(), z: cog.Z() };
      cog.delete();
      return { volume: props.Mass(), centroid };
    } finally {
      props.delete();
    }
  }
}

import type { TopoDS_Shape } from "ocjs-fluidcad";
import { getCurrentScene } from "../../scene-manager.js";
import { getOC } from "../../oc/init.js";
import { OcIO } from "../../oc/io.js";
import { Solid } from "../../common/solid.js";
import { Shape } from "../../common/shape.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import { testRect } from "../helpers/profiles.js";
import { render } from "../setup.js";

export type Bounds = { min: [number, number, number]; max: [number, number, number] };

/** Every solid the scene would hand to an export, same walk as SceneManager. */
export function sceneSolids(): Solid[] {
  const solids: Solid[] = [];
  for (const obj of getCurrentScene().getAllSceneObjects()) {
    for (const shape of obj.getAddedShapes() as Shape[]) {
      if (shape.isSolid()) {
        solids.push(shape as Solid);
      }
    }
  }
  return solids;
}

/** An axis-aligned `size`³ box at the origin, built and rendered in the current scene. */
export function box(size: number): Solid[] {
  sketch("xy", () => {
    testRect(size, size, { at: [0, 0] });
  });
  extrude(size);
  render();
  return sceneSolids();
}

const round6 = (v: number): number => +(v.toFixed(6)) + 0; // "+ 0" folds -0 into 0

/**
 * Bounds of a planar box, rounded to 1e-6: Bnd_Box pads by the shape's
 * tolerance (1e-7), which is noise for the unit checks made here.
 */
export function boundsOf(shape: TopoDS_Shape): Bounds {
  const oc = getOC();
  const bnd = new oc.Bnd_Box();
  oc.BRepBndLib.Add(shape, bnd, false);
  const lo = bnd.CornerMin();
  const hi = bnd.CornerMax();
  const bounds: Bounds = {
    min: [round6(lo.X()), round6(lo.Y()), round6(lo.Z())],
    max: [round6(hi.X()), round6(hi.Y()), round6(hi.Z())],
  };
  bnd.delete();
  return bounds;
}

export function volumeOf(shape: TopoDS_Shape): number {
  const oc = getOC();
  const props = new oc.GProp_GProps();
  oc.BRepGProp.VolumeProperties(shape, props, false, false, false);
  const volume = props.Mass();
  props.delete();
  return volume;
}

/** Reads STEP text back through the plain reader and returns the shape. */
export function readStepBack(step: string): TopoDS_Shape {
  return OcIO.readStepRaw("readback.step", new TextEncoder().encode(step));
}

/** Bounds of every vertex in an STL (ASCII or binary). */
export function stlBounds(data: Uint8Array): Bounds {
  const head = new TextDecoder().decode(data.subarray(0, Math.min(data.length, 512)));
  const points: number[][] = [];
  if (head.startsWith("solid") && /facet/.test(head)) {
    const text = new TextDecoder().decode(data);
    const re = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/g;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      points.push([Number(m[1]), Number(m[2]), Number(m[3])]);
    }
  } else {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const count = view.getUint32(80, true);
    for (let i = 0; i < count; i++) {
      const base = 84 + i * 50 + 12;
      for (let v = 0; v < 3; v++) {
        const at = base + v * 12;
        points.push([view.getFloat32(at, true), view.getFloat32(at + 4, true), view.getFloat32(at + 8, true)]);
      }
    }
  }
  if (points.length === 0) {
    throw new Error("STL has no vertices");
  }
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const p of points) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], p[k]);
      max[k] = Math.max(max[k], p[k]);
    }
  }
  return { min, max };
}

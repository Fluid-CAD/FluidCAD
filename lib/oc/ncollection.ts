import type {
  NCollection_Array1_double,
  NCollection_Array1_int,
  NCollection_Array1_gp_Pnt,
  NCollection_Array1_gp_Pnt2d,
  NCollection_Array2_gp_Pnt,
  NCollection_Array2_double,
} from "ocjs-fluidcad";
import { getOC } from "./init.js";
import type { Disposable } from "./convert.js";
import { Point2D } from "../math/point.js";

/**
 * Builders for the 1-based NCollection arrays that OCC geometry constructors
 * consume. Each returns the codebase's `Disposable` pair so call sites free
 * the native array (and nothing else) once the consumer has copied it.
 */
export class NCollections {
  static toArray1Double(values: ReadonlyArray<number>): Disposable<NCollection_Array1_double> {
    const oc = getOC();
    const array = new oc.NCollection_Array1_double(1, values.length);
    for (let i = 0; i < values.length; i++) {
      array.SetValue(i + 1, values[i]);
    }
    return [array, () => array.delete()];
  }

  static toArray1Int(values: ReadonlyArray<number>): Disposable<NCollection_Array1_int> {
    const oc = getOC();
    const array = new oc.NCollection_Array1_int(1, values.length);
    for (let i = 0; i < values.length; i++) {
      array.SetValue(i + 1, values[i]);
    }
    return [array, () => array.delete()];
  }

  /** Each point is an [x, y, z] triple. */
  static toArray1Pnt(points: ReadonlyArray<ReadonlyArray<number>>): Disposable<NCollection_Array1_gp_Pnt> {
    const oc = getOC();
    const array = new oc.NCollection_Array1_gp_Pnt(1, points.length);
    for (let i = 0; i < points.length; i++) {
      const point = new oc.gp_Pnt(points[i][0], points[i][1], points[i][2]);
      array.SetValue(i + 1, point);
      point.delete();
    }
    return [array, () => array.delete()];
  }

  static toArray1Pnt2d(points: ReadonlyArray<Point2D>): Disposable<NCollection_Array1_gp_Pnt2d> {
    const oc = getOC();
    const array = new oc.NCollection_Array1_gp_Pnt2d(1, points.length);
    for (let i = 0; i < points.length; i++) {
      const point = new oc.gp_Pnt2d(points[i].x, points[i].y);
      array.SetValue(i + 1, point);
      point.delete();
    }
    return [array, () => array.delete()];
  }

  /** Grid of [x, y, z] triples, indexed [row][column]. */
  static toArray2Pnt(grid: ReadonlyArray<ReadonlyArray<ReadonlyArray<number>>>): Disposable<NCollection_Array2_gp_Pnt> {
    const oc = getOC();
    const array = new oc.NCollection_Array2_gp_Pnt(1, grid.length, 1, grid[0].length);
    for (let row = 0; row < grid.length; row++) {
      for (let col = 0; col < grid[row].length; col++) {
        const point = new oc.gp_Pnt(grid[row][col][0], grid[row][col][1], grid[row][col][2]);
        array.SetValue(row + 1, col + 1, point);
        point.delete();
      }
    }
    return [array, () => array.delete()];
  }

  /** Grid of numbers, indexed [row][column]. */
  static toArray2Double(grid: ReadonlyArray<ReadonlyArray<number>>): Disposable<NCollection_Array2_double> {
    const oc = getOC();
    const array = new oc.NCollection_Array2_double(1, grid.length, 1, grid[0].length);
    for (let row = 0; row < grid.length; row++) {
      for (let col = 0; col < grid[row].length; col++) {
        array.SetValue(row + 1, col + 1, grid[row][col]);
      }
    }
    return [array, () => array.delete()];
  }
}

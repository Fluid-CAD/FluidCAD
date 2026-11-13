import type { TopAbs_ShapeEnum, TopoDS_Shape, TopTools_IndexedMapOfShape, TopTools_ListOfShape } from "ocjs-fluidcad";
import { getOC } from "./init.js";
import { Explorer } from "./explorer.js";
import { ShapeOps } from "./shape-ops.js";
import type { Shape } from "../common/shape.js";

/** The lineage queries an attribution reads — a fuse builder, or its adapted twin. */
export type FuseHistory = {
  Modified(shape: TopoDS_Shape): TopTools_ListOfShape;
  IsDeleted(shape: TopoDS_Shape): boolean;
};

/**
 * Which of a fuse's result solids each input went into, read off its faces.
 * A fuse only adds material, so an input lives on in exactly one result: the
 * one holding a face of it, as the fuse left it or as the fuse changed it.
 * An input whose every face the fuse swallowed — a tool buried in the stock —
 * is in none, and `resultOf` says so with -1.
 *
 * One attribution serves every input of one fuse; `delete()` frees the maps.
 */
export class FuseAttribution {
  private readonly faceMaps: TopTools_IndexedMapOfShape[];
  private readonly FACE: TopAbs_ShapeEnum;

  constructor(results: readonly Shape[], private readonly maker: FuseHistory) {
    const oc = getOC();
    this.FACE = oc.TopAbs_ShapeEnum.TopAbs_FACE as TopAbs_ShapeEnum;
    this.faceMaps = results.map(result => {
      const map = new oc.TopTools_IndexedMapOfShape();
      oc.TopExp.MapShapes(result.getShape(), this.FACE, map);
      return map;
    });
  }

  /** The index of the result holding a face of `input`, as the fuse left or changed it, or -1. */
  resultOf(input: Shape): number {
    const faces = Explorer.findShapes(input.getShape(), this.FACE);
    try {
      for (const face of faces) {
        const modified = ShapeOps.shapeListToArray(this.maker.Modified(face));
        try {
          const images = modified.length > 0 ? modified : this.maker.IsDeleted(face) ? [] : [face];
          const index = this.indexHolding(images);
          if (index >= 0) {
            return index;
          }
        } finally {
          Explorer.deleteAll(modified);
        }
      }
      return -1;
    } finally {
      Explorer.deleteAll(faces);
    }
  }

  /**
   * The inputs each result holds a face of, by index into `inputs` — one
   * list per result, parallel to the results. A result listing two or more
   * inputs merged them; a result listing one input alone is that input as
   * the fuse handed it back, rebuilt or not.
   */
  contributors(inputs: readonly Shape[]): number[][] {
    const out: number[][] = this.faceMaps.map(() => []);
    inputs.forEach((input, index) => {
      const result = this.resultOf(input);
      if (result >= 0) {
        out[result].push(index);
      }
    });
    return out;
  }

  delete(): void {
    for (const map of this.faceMaps) {
      map.delete();
    }
  }

  private indexHolding(images: readonly TopoDS_Shape[]): number {
    for (const image of images) {
      const index = this.faceMaps.findIndex(map => map.FindIndex(image) !== 0);
      if (index >= 0) {
        return index;
      }
    }
    return -1;
  }
}

import type { BRepAlgoAPI_Section, TopAbs_ShapeEnum, TopoDS_Shape } from "ocjs-fluidcad";
import { getOC } from "./init.js";
import { Convert } from "./convert.js";
import { Explorer } from "./explorer.js";
import { Plane } from "../math/plane.js";
import { Shape } from "../common/shape.js";
import { Edge } from "../common/edge.js";
import { BooleanBuilders } from "./boolean-builders.js";
import { ShapeHasher } from "./shape-hash.js";

/** How a section's curves are computed. */
export type SectionOptions = {
  /** Fit the intersection with B-splines within the kernel's tolerance (default true). */
  approximate?: boolean;
  /** Compute the curve on each side's surfaces, so the edges can later split or lie on them (default true). */
  pcurves?: boolean;
};

/**
 * One edge of a section with the face of each side the kernel cut it on: an
 * index into the face list the caller gave for that side, or -1 when the
 * edge was not cut on a face of that side — it lies on an existing edge of
 * one side (a common block: faces that touch along an edge or lie on each
 * other), or the side is a plane.
 */
export type SectionEdge = { edge: Edge; face1: number; face2: number };

/** The faces of each side the ancestors of a section's edges are looked up in. */
export type SectionFaces = { first: readonly TopoDS_Shape[]; second: readonly TopoDS_Shape[] };

/**
 * The plane section of the sketch tools (`intersect()` and the snapping in a
 * sketch): the settings it has always had, so a sketch reads the same edges
 * as before the general section existed. The kernel's own defaults: no
 * approximation, no curves on the surfaces.
 */
const PLANE_SECTION: Required<SectionOptions> = { approximate: false, pcurves: false };

export class SectionOps {

  /**
   * Where two shapes meet: the edges of `BRepAlgoAPI_Section` of `a` with
   * `b`, each its own wrapper. Empty when the kernel finds no intersection
   * or fails.
   */
  static sectionShapes(a: TopoDS_Shape, b: TopoDS_Shape, options?: SectionOptions): Edge[] {
    return SectionOps.run(oc => new oc.BRepAlgoAPI_Section(a, b, false), options ?? {}, null)
      .map(({ edge }) => edge);
  }

  /**
   * {@link sectionShapes} with, for each edge, the face of each side it was
   * cut on, as an index into `faces`. `b` may be a plane, which the section
   * takes as infinite; its side has no faces (`face2` is always -1).
   */
  static sectionWithFaces(a: TopoDS_Shape, b: TopoDS_Shape | Plane, faces: SectionFaces, options?: SectionOptions): SectionEdge[] {
    if (!(b instanceof Plane)) {
      return SectionOps.run(oc => new oc.BRepAlgoAPI_Section(a, b, false), options ?? {}, faces);
    }
    const [pln, disposePln] = Convert.toGpPln(b);
    try {
      return SectionOps.run(oc => new oc.BRepAlgoAPI_Section(a, pln, false), options ?? {}, faces);
    } finally {
      disposePln();
    }
  }

  /** The sketch tools' section of `shape` with an infinite plane (see {@link PLANE_SECTION}). */
  static sectionShapeWithPlane(plane: Plane, shape: Shape): Edge[] {
    const [pln, disposePln] = Convert.toGpPln(plane);
    try {
      return SectionOps.run(oc => new oc.BRepAlgoAPI_Section(shape.getShape(), pln, false), PLANE_SECTION, null)
        .map(({ edge }) => edge);
    } finally {
      disposePln();
    }
  }

  /**
   * The one section body: the algorithm is made with the deferred-build
   * constructor, given its settings, built, read and released
   * (`BooleanBuilders.release`, which frees what `delete()` alone leaves).
   */
  private static run(
    make: (oc: ReturnType<typeof getOC>) => BRepAlgoAPI_Section,
    options: SectionOptions,
    faces: SectionFaces | null,
  ): SectionEdge[] {
    const oc = getOC();
    const progress = new oc.Message_ProgressRange();
    const section = make(oc);
    const hasher = faces ? new ShapeHasher() : null;
    try {
      const pcurves = options.pcurves ?? true;
      section.Approximation(options.approximate ?? true);
      section.ComputePCurveOn1(pcurves);
      section.ComputePCurveOn2(pcurves);
      section.Build(progress);
      if (!section.IsDone()) {
        return [];
      }

      const first = hasher ? SectionOps.indexer(hasher, faces!.first) : null;
      const second = hasher ? SectionOps.indexer(hasher, faces!.second) : null;
      // `Shape()` and the explorer copies are the section's leftovers: each
      // edge wrapper takes its own typed copy.
      const result = section.Shape();
      try {
        return Explorer.withShapes(result, oc.TopAbs_ShapeEnum.TopAbs_EDGE as TopAbs_ShapeEnum, raws => raws.map(raw => ({
          edge: Edge.fromTopoDSEdge(Explorer.toEdge(raw)),
          face1: first ? SectionOps.ancestor(raw, first, (e, f) => section.HasAncestorFaceOn1(e, f)) : -1,
          face2: second ? SectionOps.ancestor(raw, second, (e, f) => section.HasAncestorFaceOn2(e, f)) : -1,
        })));
      } finally {
        result.delete();
      }
    } finally {
      hasher?.delete();
      BooleanBuilders.release(section);
      progress.delete();
    }
  }

  /** Each face's place in its list, by an `IsSame` key. */
  private static indexer(hasher: ShapeHasher, faces: readonly TopoDS_Shape[]): { hasher: ShapeHasher; index: Map<number, number> } {
    const index = new Map<number, number>();
    faces.forEach((face, i) => {
      const key = hasher.key(face);
      if (!index.has(key)) {
        index.set(key, i);
      }
    });
    return { hasher, index };
  }

  /** The list index of the face the kernel cut `edge` on, or -1. */
  private static ancestor(
    edge: TopoDS_Shape,
    lookup: { hasher: ShapeHasher; index: Map<number, number> },
    ask: (edge: TopoDS_Shape, face: TopoDS_Shape) => boolean,
  ): number {
    const face = new (getOC().TopoDS_Shape)();
    try {
      return ask(edge, face) && !face.IsNull() ? lookup.index.get(lookup.hasher.key(face)) ?? -1 : -1;
    } finally {
      face.delete();
    }
  }
}

import type { TopoDS_Shape, TopTools_ListOfShape } from "ocjs-fluidcad";
import type { Shape } from "../common/shape.js";
import { getOC } from "./init.js";
import { Explorer } from "./explorer.js";
import { FaceOps } from "./face-ops.js";
import { TopologyIndex } from "./topology-index.js";

/** Same angular threshold as tangent-edge display; unit: cosine. */
const MATCHING_NORMALS = 1 - 1e-6;

export type EdgeHistory = {
  Modified(edge: TopoDS_Shape): TopTools_ListOfShape;
  IsDeleted(edge: TopoDS_Shape): boolean;
};

/**
 * Display provenance for artificial boundaries within a single swept wall.
 * The actual B-rep and its raw edge indices stay intact for booleans, export
 * and explicit selections. Authored tangent junctions receive no marker.
 */
export class RenderSeams {
  /** Faces from one original profile edge describe one logical wall. */
  static fromFaceGroups(target: Shape, groups: readonly (readonly TopoDS_Shape[])[]): void {
    const oc = getOC();
    const sets = groups.filter(group => group.length > 1).map(group => TopologyIndex.buildShapeSet([...group]));
    if (!sets.length) return;
    const index = TopologyIndex.buildEdgeToFaces(target.getShape());
    const edges = Explorer.findShapes(target.getShape(), oc.TopAbs_ShapeEnum.TopAbs_EDGE);
    try {
      for (const edge of edges) {
        const faces = TopologyIndex.seekShapes(index, edge);
        try {
          if (faces.length === 2 && !faces[0].IsSame(faces[1]) &&
            sets.some(set => set.Contains(faces[0]) && set.Contains(faces[1])) &&
            RenderSeams.smooth(edge, faces)) target.recordRenderSeam(edge);
        } finally { faces.forEach(face => face.delete()); }
      }
    } finally {
      edges.forEach(edge => edge.delete()); index.delete(); sets.forEach(set => set.delete());
    }
  }

  /** Follow boolean/fillet history, then verify the edge is still a smooth join. */
  static throughHistory(target: Shape, sources: readonly Shape[], history: EdgeHistory): void {
    if (!sources.some(source => source.getRenderSeams().length)) return;
    RenderSeams.map(target, sources, edge => {
      const list = history.Modified(edge);
      const images: TopoDS_Shape[] = [];
      try {
        while (!list.IsEmpty()) { images.push(list.First()); list.RemoveFirst(); }
      } finally { list.delete(); }
      return images.length ? images : history.IsDeleted(edge) ? [] : [edge.Oriented(edge.Orientation())];
    });
    // Cutting a periodic stock face can split its unrolled domain into
    // several faces joined along the old meridian. These joins are new
    // edges, not Modified images of a tool edge, but share one source face.
    const oc = getOC();
    const groups: TopoDS_Shape[][] = [];
    const owned: TopoDS_Shape[] = [];
    try {
      for (const source of sources) {
        const faces = Explorer.findShapes(source.getShape(), oc.TopAbs_ShapeEnum.TopAbs_FACE);
        owned.push(...faces);
        for (const face of faces) {
          const list = history.Modified(face);
          const images: TopoDS_Shape[] = [];
          try {
            while (!list.IsEmpty()) { images.push(list.First()); list.RemoveFirst(); }
          } finally { list.delete(); }
          owned.push(...images);
          if (images.length > 1) groups.push(images);
        }
      }
      RenderSeams.fromFaceGroups(target, groups);
    } finally { owned.forEach(shape => shape.delete()); }
  }

  /**
   * A thick-solid offset keeps the source's own faces and edges and gives
   * every wall face one parallel image. The seams carry over as they are,
   * and the images of the two faces a seam joined meet along its parallel.
   * An outward arc join also rounds each rim into one band per rim edge;
   * the bands of the rim edges meeting at a seam's end are one band too.
   */
  static throughOffset(target: Shape, source: Shape, offset: { Generated(shape: TopoDS_Shape): TopTools_ListOfShape }): void {
    const seams = source.getRenderSeams();
    if (!seams.length) return;
    RenderSeams.map(target, [source]);
    const oc = getOC();
    const owned: TopoDS_Shape[] = [];
    const images = (shapes: TopoDS_Shape[]) => shapes.flatMap(shape => {
      const list = offset.Generated(shape);
      const generated: TopoDS_Shape[] = [];
      try {
        while (!list.IsEmpty()) { generated.push(list.First()); list.RemoveFirst(); }
      } finally { list.delete(); }
      owned.push(shape, ...generated);
      return generated;
    });
    const faces = TopologyIndex.buildEdgeToFaces(source.getShape());
    const edges = new oc.TopTools_IndexedDataMapOfShapeListOfShape();
    oc.TopExp.MapShapesAndAncestors(source.getShape(), oc.TopAbs_ShapeEnum.TopAbs_VERTEX, oc.TopAbs_ShapeEnum.TopAbs_EDGE, edges);
    try {
      const groups: TopoDS_Shape[][] = [];
      for (const seam of seams) {
        groups.push(images(TopologyIndex.seekShapes(faces, seam)));
        const ends = Explorer.findShapes(seam, oc.TopAbs_ShapeEnum.TopAbs_VERTEX);
        owned.push(...ends);
        for (const end of ends) groups.push(images(TopologyIndex.seekShapes(edges, end)));
      }
      RenderSeams.fromFaceGroups(target, groups);
    } finally { owned.forEach(shape => shape.delete()); faces.delete(); edges.delete(); }
  }

  /** Mapper returns owned handles. Unchanged geometry is copied by default. */
  static map(target: Shape, sources: readonly Shape[], mapper = (edge: TopoDS_Shape): TopoDS_Shape[] => [edge.Oriented(edge.Orientation())]): void {
    const seams = sources.flatMap(source => [...source.getRenderSeams()]);
    if (!seams.length) return;
    const oc = getOC();
    const index = TopologyIndex.buildEdgeToFaces(target.getShape());
    const seen = new oc.TopTools_MapOfShape();
    try {
      for (const seam of seams) {
        const images = mapper(seam);
        try {
          for (const edge of images) {
            if (edge.IsNull() || edge.ShapeType() !== oc.TopAbs_ShapeEnum.TopAbs_EDGE || !seen.Add(edge)) continue;
            const faces = TopologyIndex.seekShapes(index, edge);
            try {
              if (faces.length === 2 && !faces[0].IsSame(faces[1]) && RenderSeams.smooth(edge, faces)) {
                target.recordRenderSeam(edge);
              }
            } finally { faces.forEach(face => face.delete()); }
          }
        } finally { images.forEach(edge => edge.delete()); }
      }
    } finally { index.delete(); seen.delete(); }
  }

  private static smooth(edge: TopoDS_Shape, faces: TopoDS_Shape[]): boolean {
    const oc = getOC();
    const rawEdge = oc.TopoDS.Edge(edge);
    const a = oc.TopoDS.Face(faces[0]), b = oc.TopoDS.Face(faces[1]);
    try {
      // A later cut can turn a former construction seam into a real corner.
      // Fail closed if normals are unavailable or disagree along the edge.
      return [0.2, 0.5, 0.8].every(fraction => {
        const n1 = FaceOps.outwardNormalOnEdge(a, rawEdge, fraction);
        const n2 = FaceOps.outwardNormalOnEdge(b, rawEdge, fraction);
        return n1 !== null && n2 !== null && n1.dot(n2) > MATCHING_NORMALS;
      });
    } finally { rawEdge.delete(); a.delete(); b.delete(); }
  }
}

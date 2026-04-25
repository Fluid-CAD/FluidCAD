import type { BRepBuilderAPI_MakeShape, TopAbs_ShapeEnum, TopoDS_Shape } from "occjs-wrapper";
import { getOC } from "../oc/init.js";
import { Explorer } from "../oc/explorer.js";
import { ShapeOps } from "../oc/shape-ops.js";
import { Face } from "./face.js";
import { Edge } from "./edge.js";
import { Shape } from "./shape.js";

export type ShapeHistoryRecord<T> = {
  sources: T[];
  results: T[];
};

export type ShapeHistory = {
  addedFaces: Face[];
  modifiedFaces: ShapeHistoryRecord<Face>[];
  generatedFaces: ShapeHistoryRecord<Face>[];
  removedFaces: Face[];
  addedEdges: Edge[];
  modifiedEdges: ShapeHistoryRecord<Edge>[];
  generatedEdges: ShapeHistoryRecord<Edge>[];
  removedEdges: Edge[];
};

export class ShapeHistoryTracker {
  /**
   * Remap a list of pre-operation faces through a `ShapeHistory`'s
   * modifications. For each input face:
   *   - If it appears as a source in `modifiedFaces`, emit the corresponding
   *     result faces (1:N).
   *   - Otherwise, pass it through unchanged (it survived the operation with
   *     the same TShape pointer).
   *
   * Use this to keep classification arrays (start/end/side/…) valid after a
   * fusion has modified some of their faces.
   */
  static remapFaces(faces: Face[], history: ShapeHistory): Face[] {
    const result: Face[] = [];
    for (const face of faces) {
      const record = history.modifiedFaces.find(m =>
        m.sources.some(s => s.getShape().IsSame(face.getShape()))
      );
      if (record) {
        result.push(...record.results);
      } else {
        result.push(face);
      }
    }
    return result;
  }

  static remapEdges(edges: Edge[], history: ShapeHistory): Edge[] {
    const result: Edge[] = [];
    for (const edge of edges) {
      const record = history.modifiedEdges.find(m =>
        m.sources.some(s => s.getShape().IsSame(edge.getShape()))
      );
      if (record) {
        result.push(...record.results);
      } else {
        result.push(edge);
      }
    }
    return result;
  }

  /**
   * Collect history for `inputs` against `maker`'s output. When `opts.skipAdded`
   * is set, the added* fields come back empty — callers that compute additions
   * themselves (e.g. `recordFusionHistory` aggregates across all scene shapes)
   * skip the per-call output traversal and per-result claimed-map updates.
   */
  static collect(
    maker: BRepBuilderAPI_MakeShape,
    inputs: Shape[],
    opts: { skipAdded?: boolean } = {},
  ): ShapeHistory {
    const oc = getOC();
    const FACE = oc.TopAbs_ShapeEnum.TopAbs_FACE as TopAbs_ShapeEnum;
    const EDGE = oc.TopAbs_ShapeEnum.TopAbs_EDGE as TopAbs_ShapeEnum;

    const skipAdded = opts.skipAdded === true;
    const output = skipAdded ? null : maker.Shape();
    const outputFaces = output ? Explorer.findShapes(output, FACE) : [];
    const outputEdges = output ? Explorer.findShapes(output, EDGE) : [];

    const faces = ShapeHistoryTracker.collectForType(
      maker,
      inputs,
      FACE,
      outputFaces,
      (raw) => Face.fromTopoDSFace(Explorer.toFace(raw)),
      skipAdded,
    );
    const edges = ShapeHistoryTracker.collectForType(
      maker,
      inputs,
      EDGE,
      outputEdges,
      (raw) => Edge.fromTopoDSEdge(Explorer.toEdge(raw)),
      skipAdded,
    );

    return {
      addedFaces: faces.added,
      modifiedFaces: faces.modified,
      generatedFaces: faces.generated,
      removedFaces: faces.removed,
      addedEdges: edges.added,
      modifiedEdges: edges.modified,
      generatedEdges: edges.generated,
      removedEdges: edges.removed,
    };
  }

  private static collectForType<T extends Shape>(
    maker: BRepBuilderAPI_MakeShape,
    inputs: Shape[],
    type: TopAbs_ShapeEnum,
    outputRaws: TopoDS_Shape[],
    wrap: (raw: TopoDS_Shape) => T,
    skipAdded: boolean,
  ) {
    const oc = getOC();

    const modified: ShapeHistoryRecord<T>[] = [];
    const generated: ShapeHistoryRecord<T>[] = [];
    const removed: T[] = [];

    // Track which output raws are claimed by a Modified/Generated record so the
    // remaining outputs can be reported as pure additions. When `skipAdded`,
    // we don't compute additions, so skip the bookkeeping entirely.
    const claimed = skipAdded ? null : new oc.TopTools_MapOfShape();

    const isOfType = (raw: TopoDS_Shape) => raw.ShapeType() === type;

    for (const input of inputs) {
      const inputRaws = Explorer.findShapes(input.getShape(), type);

      for (const inputRaw of inputRaws) {
        const modifiedRaws = ShapeOps.shapeListToArray(maker.Modified(inputRaw)).filter(isOfType);
        const generatedRaws = ShapeOps.shapeListToArray(maker.Generated(inputRaw)).filter(isOfType);

        if (modifiedRaws.length > 0) {
          modified.push({
            sources: [wrap(inputRaw)],
            results: modifiedRaws.map(wrap),
          });
          if (claimed) {
            for (const r of modifiedRaws) {
              claimed.Add(r);
            }
          }
        }

        if (generatedRaws.length > 0) {
          generated.push({
            sources: [wrap(inputRaw)],
            results: generatedRaws.map(wrap),
          });
          if (claimed) {
            for (const r of generatedRaws) {
              claimed.Add(r);
            }
          }
        }

        // IsDeleted is only meaningful when the input has no successor. If
        // Modified or Generated produced anything, that record already
        // captures its fate — skip the (relatively expensive) IsDeleted call.
        if (modifiedRaws.length === 0 && generatedRaws.length === 0
          && maker.IsDeleted(inputRaw)) {
          removed.push(wrap(inputRaw));
        }
      }
    }

    const added: T[] = [];
    if (claimed) {
      for (const raw of outputRaws) {
        if (!claimed.Contains(raw)) {
          added.push(wrap(raw));
        }
      }
      claimed.delete();
    }

    return { added, modified, generated, removed };
  }
}

import { SceneObject } from "../common/scene-object.js";
import { Shape, ShapeFilter } from "../common/shape.js";
import { ShapeType } from "../common/shape-type.js";
import { Face } from "../common/face.js";
import { Edge } from "../common/edge.js";
import { Vertex } from "../common/vertex.js";
import { Plane } from "../math/plane.js";
import { LazyVertex } from "./lazy-vertex.js";
import {
  anchorFromShape,
  buildOrthonormalFrame,
  describeAnchor,
  EdgeAnchorOffsetMode,
  FrameOptions,
  VertexAnchorSpec,
} from "./shape-anchor.js";

function anchorUniqueName(spec: VertexAnchorSpec): string {
  const suffix = spec.kind === "offset" ? `offset-${spec.mode}-${spec.value}` : spec.kind;
  return `anchor-${suffix}`;
}

/**
 * The first face/edge of the selection is the anchor's reference shape —
 * `.center()` on a multi-face selection means "center of the first face".
 */
function resolveAnchorShape(source: SceneObject, spec: VertexAnchorSpec): Shape {
  const shapes = source.getShapes({ excludeMeta: false, excludeGuide: false });
  for (const shape of shapes) {
    if (shape instanceof Face || shape instanceof Edge) {
      return shape;
    }
  }
  throw new Error(`${describeAnchor(spec)}: the selection resolved to no faces or edges.`);
}

/**
 * A `LazyVertex` pinned to a well-known point of a face/edge selection —
 * produced by `.center()` / `.start()` / `.end()` / `.offset(...)` on
 * `select(...)` and on lazy accessors like `e.endFaces()`. Besides the
 * vertex position it can derive a full connector-style frame whose Z comes
 * from the underlying shape (face normal / circle axis / edge tangent), so
 * `connector('name', e.endFaces().center())` stays oriented to the geometry.
 */
export class AnchoredLazyVertex extends LazyVertex {
  constructor(
    private readonly sourceSelection: SceneObject,
    private readonly spec: VertexAnchorSpec,
  ) {
    super(anchorUniqueName(spec), () => [
      Vertex.fromPoint(anchorFromShape(resolveAnchorShape(sourceSelection, spec), spec).origin),
    ]);
  }

  getSourceSelection(): SceneObject {
    return this.sourceSelection;
  }

  getAnchorSpec(): VertexAnchorSpec {
    return this.spec;
  }

  getAnchorFrame(options: FrameOptions = {}): Plane {
    const anchor = anchorFromShape(resolveAnchorShape(this.sourceSelection, this.spec), this.spec);
    return buildOrthonormalFrame(anchor.origin, anchor.zDir, options);
  }

  /**
   * Scene-wide probes (fusion-scope collection, select universes) call
   * getShapes on every registered object — including this vertex before its
   * source selection has built. The inherited lazy self-build would throw
   * mid-way through another object's build, so report empty until the
   * source can actually answer.
   */
  override getShapes(filter?: ShapeFilter, type?: ShapeType): Shape[] {
    const sourceShapes = this.sourceSelection.getShapes({ excludeMeta: false, excludeGuide: false });
    if (!sourceShapes.some(s => s instanceof Face || s instanceof Edge)) {
      return [];
    }
    return super.getShapes(filter, type);
  }

  override getDependencies(): SceneObject[] {
    return [this.sourceSelection];
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    const remapped = remap.get(this.sourceSelection) || this.sourceSelection;
    return new AnchoredLazyVertex(remapped, this.spec);
  }

  override compareTo(other: LazyVertex): boolean {
    if (!(other instanceof AnchoredLazyVertex)) {
      return false;
    }
    // super covers the unique name, which encodes the anchor spec.
    if (!super.compareTo(other)) {
      return false;
    }
    return this.sourceSelection.compareTo(other.sourceSelection);
  }
}

/**
 * Shared base for selection scene objects that expose vertex-reference
 * accessors. `start`/`end`/`offset` follow the edge's canonical direction —
 * derived from geometry (straight edges lean positive along the leading
 * world axis), so every selection path and rebuild agrees.
 * `offset('absolute', d)` measures from the start (negative = from the end)
 * and only works on straight lines.
 */
export abstract class AnchorableSelection extends SceneObject {
  center(): LazyVertex {
    return new AnchoredLazyVertex(this, { kind: "center" });
  }

  start(): LazyVertex {
    return new AnchoredLazyVertex(this, { kind: "start" });
  }

  end(): LazyVertex {
    return new AnchoredLazyVertex(this, { kind: "end" });
  }

  offset(mode: EdgeAnchorOffsetMode, value: number): LazyVertex {
    if (mode !== "relative" && mode !== "absolute") {
      throw new Error(`offset(): mode must be 'relative' or 'absolute' (got ${JSON.stringify(mode)}).`);
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`offset(): value must be a finite number (got ${JSON.stringify(value)}).`);
    }
    return new AnchoredLazyVertex(this, { kind: "offset", mode, value });
  }
}

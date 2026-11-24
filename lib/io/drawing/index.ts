import type { TopoDS_Shape } from "ocjs-fluidcad";
import type { HiddenLineEdges, ViewShape } from "../../oc/projection/hidden-line.js";
import { ViewProjection } from "../../oc/projection/view-projection.js";
import type { ViewBody, ViewStats } from "../../oc/projection/view-projection.js";
import { EdgeToCurve2D } from "../../oc/projection/edge-to-curve2d.js";
import { Plane, isStandardPlane, toPlane } from "../../math/plane.js";
import type { StandardPlane } from "../../math/plane.js";
import type { LengthUnit } from "../../units/units.js";
import { withUnit } from "../../units/registry.js";
import type { Drawing2D, DrawingEntity, DrawingLayer } from "./drawing.js";
import { Curves, DRAWING_TOLERANCE_MM } from "./drawing.js";
import { DrawingCleanup } from "./cleanup.js";

export type { Curve2D, Drawing2D, DrawingBounds, DrawingEntity, DrawingLayer, Vec2 } from "./drawing.js";
export { Curves, DRAWING_LAYERS, DRAWING_TOLERANCE_MM } from "./drawing.js";
export { DrawingCleanup } from "./cleanup.js";
export type { DrawingChain, DrawingChainItem } from "./cleanup.js";
export { DxfWriter } from "./dxf-writer.js";
export { SvgWriter, SVG_DEFAULT_MARGIN_MM, SVG_DEFAULT_STROKE_WIDTH_MM } from "./svg-writer.js";
export type { SvgWriterOptions } from "./svg-writer.js";
export type { ViewShape } from "../../oc/projection/hidden-line.js";
export type { ViewBody, ViewStats } from "../../oc/projection/view-projection.js";

/** The 2D formats: a view of the model drawn on a plane. */
export type DrawingFormat = 'dxf' | 'svg';

/** What a drawing shows, whatever file it is written to. */
export interface DrawingViewOptions {
  /**
   * The plane the model is drawn on, seen from the side its normal points
   * to: `'top'` / `'xy'` looks down the Z axis, `'front'` / `'xz'` from −Y.
   */
  plane: StandardPlane;
  /** Draw the edges behind the model too, on their own dashed layer. Off by default. */
  hiddenLines?: boolean;
  /**
   * Draw the smooth joins between faces — a fillet's borders, a flat side
   * running into a round one — on their own layer. Off by default. Smooth is
   * read from the geometry, so it holds whatever feature built the faces.
   */
  tangentEdges?: boolean;
}

/** The options of a drawing export (`FileExport.exportShapes` with a 2D format). */
export interface DrawingExportOptions extends DrawingViewOptions {
  format: DrawingFormat;
  /** The unit the shapes' numbers are in; the drawing keeps them and declares it. Defaults as for STEP. */
  unit?: LengthUnit;
  /**
   * SVG only: how the drawing is put on the page, in millimetres on paper —
   * the stroke visible edges are drawn with (0.25 by default) and the blank
   * margin around the drawing (5 by default).
   */
  svg?: { strokeWidth?: number; margin?: number };
}

/**
 * Shapes → the drawing of their view on a plane: hidden-line removal, exact
 * projection of what is left, then the cleanup that makes it one clean curve
 * per edge. The writers (`DxfWriter`, `SvgWriter`) take it from here.
 */
export class DrawingExport {
  /**
   * The view of `shapes` on a standard plane. All shapes are drawn together,
   * so they hide each other as they would on screen. Model coordinates are
   * kept: nothing is recentred, a point at model (12, 7, z) is at (12, 7) in
   * a top view.
   *
   * A shape may come with the render seams its wrapper recorded
   * (`{ shape, renderSeams }`): the drawing leaves out every edge the viewer
   * does — those, and the kernel's own seams.
   */
  static fromShapes(shapes: readonly (TopoDS_Shape | ViewShape)[], options: DrawingViewOptions & { unit: LengthUnit }): Drawing2D {
    if (!isStandardPlane(options.plane)) {
      throw new Error(`Unknown drawing plane ${JSON.stringify(options.plane)}`);
    }
    const drawing = DrawingExport.onPlane(shapes, toPlane(options.plane), options);
    drawing.plane = options.plane;
    return drawing;
  }

  /** {@link fromShapes} for any plane — a face's, a `plane()` feature's. */
  static onPlane(
    shapes: readonly (TopoDS_Shape | ViewShape)[],
    plane: Plane,
    options: { unit: LengthUnit; hiddenLines?: boolean; tangentEdges?: boolean },
  ): Drawing2D {
    return DrawingExport.drawn(plane, options, () => ViewProjection.project(
      shapes.map((shape) => ('shape' in shape ? shape : { shape })), plane,
      { hidden: options.hiddenLines === true, tangent: options.tangentEdges === true },
    ));
  }

  /**
   * The view of an assembly's bodies on a standard plane: each body a shape
   * in its own frame with the pose that places it. The drawing is the one
   * {@link fromShapes} would make of the placed shapes; it is computed body
   * by body (`ViewProjection`), which is what keeps an assembly's view
   * to seconds.
   */
  static fromBodies(
    bodies: readonly ViewBody[],
    options: DrawingViewOptions & { unit: LengthUnit },
    onStats?: (stats: ViewStats) => void,
  ): Drawing2D {
    if (!isStandardPlane(options.plane)) {
      throw new Error(`Unknown drawing plane ${JSON.stringify(options.plane)}`);
    }
    const plane = toPlane(options.plane);
    const drawing = DrawingExport.drawn(plane, options, () => {
      const edges = ViewProjection.project(bodies, plane, {
        hidden: options.hiddenLines === true,
        tangent: options.tangentEdges === true,
      });
      onStats?.(edges.stats);
      return edges;
    });
    drawing.plane = options.plane;
    return drawing;
  }

  /** The edges of a view → the drawing: exact projection of each, then the cleanup. */
  private static drawn(plane: Plane, options: { unit: LengthUnit }, project: () => HiddenLineEdges): Drawing2D {
    const tolerance = Curves.tolerance(options.unit, DRAWING_TOLERANCE_MM);
    const raw: DrawingEntity[] = [];
    let approximated = 0;

    // The kernel helpers read their tolerances from the active unit.
    withUnit(options.unit, () => {
      const edges = project();
      try {
        const layers: DrawingLayer[] = ['visible', 'tangent', 'hidden'];
        for (const layer of layers) {
          for (const edge of edges[layer]) {
            const projected = EdgeToCurve2D.convert(edge, plane, tolerance);
            if (!projected.curve) {
              continue;
            }
            raw.push({ layer, curve: projected.curve });
            if (projected.approximated) {
              approximated++;
            }
          }
        }
      } finally {
        edges.dispose();
      }
    });

    const entities = DrawingCleanup.run(raw, tolerance);
    const warnings: string[] = [];
    if (approximated > 0) {
      warnings.push(
        `${approximated} curve${approximated === 1 ? ' was' : 's were'} approximated by polylines: `
        + 'the kernel could not hand them over as splines.',
      );
    }
    return { unit: options.unit, entities, bounds: Curves.boundsOf(entities), warnings };
  }
}

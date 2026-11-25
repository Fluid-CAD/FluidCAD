import { isPoint2DLike, Point2DLike } from "../../math/point.js";
import { SolvedEllipticalArc } from "../../features/2d/solved/elliptical-arc.js";
import { normalizePoint2D } from "../../helpers/normalize.js";
import { registerBuilder, SceneParserContext } from "../../index.js";
import { IEllipticalArc } from "../interfaces.js";
import { type NumberParam, resolveParam } from "../param.js";

interface EArcFunction {
  /**
   * Draws an elliptical arc: an open piece of an ellipse, from a start
   * point to an end point. The first three arguments read like `arc()`,
   * the last three like `ellipse()`. It is a solver entity, so every
   * literal is a guess the constraints drive: the ellipse's center, its
   * two semi-radii (`radius(ea, v, 'x')` for RX, `radius(ea, v, 'y')` for
   * RY) and the rotation of its RX axis (`horizontal`/`vertical`,
   * `tangent`), and where along the ellipse each end sits. An end literal
   * that is not exactly on the ellipse names the point of the ellipse in
   * its direction. The arc runs counter-clockwise from start to end; chain
   * `.cw()` to take the other side.
   * @param startPoint - The start point (a guess, like every literal)
   * @param endPoint - The end point
   * @param centerPoint - The center of the ellipse the arc lies on
   * @param rx - Semi-radius guess along the ellipse's RX axis
   * @param ry - Semi-radius guess along the ellipse's RY axis
   * @param rotation - Guess for the RX axis's angle from the plane's X
   *   direction, degrees (default 0)
   */
  (
    startPoint: Point2DLike,
    endPoint: Point2DLike,
    centerPoint: Point2DLike,
    rx: NumberParam,
    ry: NumberParam,
    rotation?: NumberParam,
  ): IEllipticalArc;
}

function build(context: SceneParserContext): EArcFunction {
  return function eArc() {
    if (arguments.length < 5 || arguments.length > 6
        || !isPoint2DLike(arguments[0]) || !isPoint2DLike(arguments[1]) || !isPoint2DLike(arguments[2])) {
      throw new Error(
        "eArc() needs full specification: eArc(start, end, center, rx, ry) " +
        "or eArc(start, end, center, rx, ry, rotation)",
      );
    }
    const rx = resolveParam(arguments[3] as NumberParam);
    const ry = resolveParam(arguments[4] as NumberParam);
    const rotation = arguments.length === 6 ? resolveParam(arguments[5] as NumberParam) : null;
    if (rotation !== null && !Number.isFinite(rotation)) {
      throw new Error("eArc(): rotation must be a finite number of degrees");
    }
    const solved = new SolvedEllipticalArc(
      normalizePoint2D(arguments[0] as Point2DLike).asPoint2D(),
      normalizePoint2D(arguments[1] as Point2DLike).asPoint2D(),
      normalizePoint2D(arguments[2] as Point2DLike).asPoint2D(),
      rx,
      ry,
      rotation,
    );
    context.addSceneObject(solved);
    const activeSketch = context.getActiveSketch();
    if (activeSketch) {
      solved.register(activeSketch);
    }
    return solved;
  } as EArcFunction;
}

export default registerBuilder(build);

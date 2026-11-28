import { SceneObject } from "../common/scene-object.js";
import { Bridge } from "../features/bridge.js";
import { LazyVertex } from "../features/lazy-vertex.js";
import { SolvedPoint } from "../features/2d/solved/point.js";
import { registerBuilder, SceneParserContext } from "../index.js";
import { IBridge, ISceneObject } from "./interfaces.js";
import { OperandArguments } from "./operand-arguments.js";

interface BridgeFunction {
  /**
   * A smooth curve between two curve ends — closing a gap between two
   * guide curves, a transition that leaves one edge and arrives at another,
   * the fourth side of a fill boundary. It matches the tangent at each end
   * by default; `.continuity('g2')` matches the curvature too, and
   * `.continuity('g0')` only the position (a straight line).
   * `.continuity(start, end)` gives each end its own — `'g0'` at a solid's
   * corner, written as an edge end, meets the corner without following the
   * edge.
   *
   * At the end of a curve the bridge continues it: it leaves `from` in the
   * direction that curve was heading and arrives at `to` heading into that
   * curve. There is nothing to flip — the order of the two ends only sets
   * the direction of the result. An end that is a plain point (a sketch
   * point, a vertex) matches position only.
   *
   * `.startMagnitude(n)` and `.endMagnitude(n)` set how far the bridge
   * keeps going straight before it turns at each end: 1 by default, larger
   * is fuller, smaller is tighter.
   *
   * The result is a curve object of one wire with one edge: `edges()`,
   * `start()` and `end()` read it. The curves the ends lie on are read, not
   * used up.
   * @param from - Where the bridge starts: `.start()` or `.end()` of an edge selection or of a curve (`c.end()`, `c.edges(0).start()`, `e.sideEdges(2).end()`), a sketch entity's end (`sk.geometries.l.end()`), or a point (a sketch point, a vertex).
   * @param to - Where it ends: the same kinds as `from`.
   */
  (from: LazyVertex | ISceneObject, to: LazyVertex | ISceneObject): IBridge;
}

/** The two ends, in the order written, as the refusals name them. */
const ENDS = ['from', 'to'] as const;

/**
 * One end argument: a vertex — an edge's or a curve's `.start()` or
 * `.end()`, a sketch point's accessor, any other point — or a sketch point
 * statement. That it names the end of an edge or a point at all is read
 * when the curve builds (`CurveEnds.read`).
 */
function endArgument(value: unknown, name: typeof ENDS[number]): SceneObject {
  if (value instanceof LazyVertex || value instanceof SolvedPoint) {
    return value;
  }
  throw new Error(`bridge: the ${name} argument must be a curve end, the start() or end() of an edge or a curve, or a point; got ${describe(value)}.`);
}

/** A value that is no end, as the refusal names it: `an extrude`, `a select`, `3`, `'xy'`. */
function describe(value: unknown): string {
  if (!(value instanceof SceneObject)) {
    return OperandArguments.describe(value);
  }
  const type = value.getType();
  return `${/^[aeiou]/.test(type) ? 'an' : 'a'} ${type}`;
}

/**
 * The two arguments of `bridge(from, to)`, each read as an end. Fewer or
 * more than two, or one that is no end, is refused.
 */
export function bridgeArgs(args: readonly unknown[]): [SceneObject, SceneObject] {
  if (args.length < 2) {
    throw new Error(`bridge: give the two ends to join: bridge(from, to), each the start() or end() of an edge or a curve, or a point.`);
  }
  if (args.length > 2) {
    throw new Error(`bridge: takes two arguments, the two ends, got ${args.length}.`);
  }
  return [endArgument(args[0], 'from'), endArgument(args[1], 'to')];
}

function build(context: SceneParserContext): BridgeFunction {
  return function bridge(...args: unknown[]) {
    if (context.getActiveSketch()) {
      throw new Error(`bridge: is written outside a sketch; inside one, draw the curve with bezier().`);
    }
    const [from, to] = bridgeArgs(args);
    // An end made for this call (`e.sideEdges(2).end()`, `c.end()`) wraps a
    // lazy selection registered nowhere else: it goes into the scene ahead
    // of the end, so both build before the bridge, as a hole's placements do.
    const operands = [from, to].flatMap(end => end.isLazy() ? [...end.getDependencies(), end] : [end]);
    return OperandArguments.addTool(context, operands, () => new Bridge(from, to));
  } as BridgeFunction;
}

export default registerBuilder(build);

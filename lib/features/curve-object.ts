import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { Shape } from "../common/shape.js";
import { Edge } from "../common/edge.js";
import { Wire } from "../common/wire.js";
import { BuildError } from "../common/build-error.js";
import { ICurveResult, ISelection } from "../core/interfaces.js";
import { BucketSelection, EdgeBucketArgs } from "./bucket-selection.js";
import { ClassifiedBuckets } from "./classified-buckets.js";
import { CurveEnd, CurveEndVertex } from "./curve-end-vertex.js";
import { LazyVertex } from "./lazy-vertex.js";
import { ResultObject } from "./result-object.js";

/**
 * A tool whose result is a curve: one or more wires or edges standing in the
 * scene on their own (a helix, an intersection, a projection). A subclass
 * builds the curves in {@link buildCurves}; this class adds them, records
 * them, writes the `edges` bucket and takes the operands.
 *
 * A curve is construction geometry, like a sketch: a tool that reads it
 * hides it, and any later tool may read it again.
 */
export abstract class CurveObject extends ResultObject implements ICurveResult {

  /** State key of the result's edges, the bucket `edges()` reads (see `BucketDefs.EDGES`). */
  static readonly EDGES_KEY = 'section-edges';

  /**
   * The curves the tool leaves: wires, one per connected chain, or single
   * edges. They become the object's shapes as they are; an empty list, or
   * anything that is not an edge or a wire, fails the build.
   */
  protected abstract buildCurves(context: BuildSceneObjectContext): Shape[];

  override build(context?: BuildSceneObjectContext): void {
    this.resolveLazyOperands();
    const curves = this.buildCurves(context);

    const stray = curves.find(shape => !(shape instanceof Edge) && !(shape instanceof Wire));
    if (stray) {
      const type = stray.getType();
      curves.forEach(shape => shape.dispose());
      throw new Error(`${this.toolName()}: a curve tool leaves edges or wires, and its build returned a ${type}.`);
    }
    if (curves.length === 0) {
      throw new BuildError(
        `${this.toolName()}: no curve was made.`,
        `Check that the inputs meet or overlap where the curve is expected.`,
      );
    }

    this.addShapes(curves);
    ClassifiedBuckets.recordAdditions(this, curves);
    this.setState(CurveObject.EDGES_KEY, curves.flatMap(curve => CurveObject.edgesOf(curve)));
    this.setState(CurveEndVertex.STATE_KEY, CurveEndVertex.endsOf(CurveObject.edgesOf(curves[0])));

    this.consumeOperands();
  }

  /** Every edge of the result, in walk order: curve after curve, each from its start. */
  edges(...args: EdgeBucketArgs): ISelection {
    const name = this.generateUniqueName(BucketSelection.suffix(CurveObject.EDGES_KEY, args));
    return BucketSelection.edges(this, name, CurveObject.EDGES_KEY, args);
  }

  /** Where the curve starts: the first curve's, when the result is several. An anchor on its first edge. */
  start(): LazyVertex {
    return this.endVertex('start');
  }

  /** Where the curve ends: the first curve's, when the result is several. An anchor on its last edge. */
  end(): LazyVertex {
    return this.endVertex('end');
  }

  private endVertex(end: CurveEnd): LazyVertex {
    return new CurveEndVertex(this, this.generateUniqueName(`curve-${end}`), end);
  }

  override consumedForDisplayOnly(): boolean {
    return true;
  }

  /** A curve's own edges: the edge itself, or a wire's edges in its walk. */
  private static edgesOf(curve: Shape): Edge[] {
    return curve instanceof Wire ? curve.getEdges() : [curve as Edge];
  }
}

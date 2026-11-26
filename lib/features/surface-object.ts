import { BuildSceneObjectContext } from "../common/scene-object.js";
import { Shape } from "../common/shape.js";
import { Sheet } from "../common/sheet.js";
import { BuildError } from "../common/build-error.js";
import { ISelection, ISurfaceResult } from "../core/interfaces.js";
import { requireValidSheet } from "../oc/sheet-validation.js";
import { BucketSelection, EdgeBucketArgs, FaceBucketArgs } from "./bucket-selection.js";
import { ClassifiedBuckets } from "./classified-buckets.js";
import { ResultObject } from "./result-object.js";

/**
 * A tool whose result is a surface: one or more sheets standing in the scene
 * as bodies (an offset surface, a fill, a ruled surface). A subclass builds
 * the sheets in {@link buildSheets}; this class validates them, adds them,
 * records them, writes the `faces` and `boundaryEdges` buckets and takes the
 * operands.
 *
 * A subclass with buckets of its own (a ruled surface's start, end and side
 * edges) writes their state in `buildSheets` and defines the accessors with
 * `BucketSelection`.
 */
export abstract class SurfaceObject extends ResultObject implements ISurfaceResult {

  /** State key of the result's faces, the bucket `faces()` reads (see `BucketDefs.FACES`). */
  static readonly FACES_KEY = 'faces';

  /** State key of the result's rim, the bucket `boundaryEdges()` reads (see `BucketDefs.EDGES`). */
  static readonly BOUNDARY_EDGES_KEY = 'boundary-edges';

  /**
   * The surfaces the tool leaves. They become the object's shapes as they
   * are; an empty list, or a sheet whose faces are not sound, fails the
   * build.
   */
  protected abstract buildSheets(context: BuildSceneObjectContext): Sheet[];

  override build(context?: BuildSceneObjectContext): void {
    this.resolveLazyOperands();
    const sheets = this.buildSheets(context);

    try {
      const stray = (sheets as Shape[]).find(shape => !(shape instanceof Sheet));
      if (stray) {
        throw new Error(`${this.toolName()}: a surface tool leaves surfaces, and its build returned a ${stray.getType()}.`);
      }
      if (sheets.length === 0) {
        throw new BuildError(
          `${this.toolName()}: no surface was made.`,
          `Check that the inputs describe a surface: a closed boundary, edges with room to grow from.`,
        );
      }
      for (const sheet of sheets) {
        requireValidSheet(sheet.getShape(), this.toolName(), 1);
      }
    } catch (error) {
      sheets.forEach(sheet => sheet.dispose());
      throw error;
    }

    this.addShapes(sheets);
    ClassifiedBuckets.recordAdditions(this, sheets);
    this.setState(SurfaceObject.FACES_KEY, sheets.flatMap(sheet => sheet.getFaces()));
    this.setState(SurfaceObject.BOUNDARY_EDGES_KEY, sheets.flatMap(sheet => sheet.getBoundaryEdges()));

    this.consumeOperands();
  }

  /** Every face of the result, surface after surface. */
  faces(...args: FaceBucketArgs): ISelection {
    const name = this.generateUniqueName(BucketSelection.suffix(SurfaceObject.FACES_KEY, args));
    return BucketSelection.faces(this, name, SurfaceObject.FACES_KEY, args);
  }

  /** The open rim: every edge of the result that bounds one face only. */
  boundaryEdges(...args: EdgeBucketArgs): ISelection {
    const name = this.generateUniqueName(BucketSelection.suffix(SurfaceObject.BOUNDARY_EDGES_KEY, args));
    return BucketSelection.edges(this, name, SurfaceObject.BOUNDARY_EDGES_KEY, args);
  }
}

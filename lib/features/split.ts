import type { TopAbs_ShapeEnum } from "ocjs-fluidcad";
import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { BuildError } from "../common/build-error.js";
import { Shape } from "../common/shape.js";
import { Solid } from "../common/solid.js";
import { requireShapes } from "../common/operand-check.js";
import type { ShapeHistory } from "../common/shape-history-tracker.js";
import { Plane } from "../math/plane.js";
import { getOC } from "../oc/init.js";
import { Explorer } from "../oc/explorer.js";
import { SplitOps } from "../oc/split-ops.js";
import { heldSolidsOf, liveOperandShapes, type HeldShape } from "../helpers/live-solids.js";
import { recordModifierHistory } from "../helpers/scene-helpers.js";
import { ISplit } from "../core/interfaces.js";
import { PlaneObjectBase } from "./plane-renderable-base.js";
import { PlaneFromSketchLine } from "./plane-from-sketch-line.js";

/** A side of the split plane: `front` is where the plane normal points. */
export type SplitSide = 'front' | 'back';

/** Which pieces a split keeps — both sides, or one of them. */
export type SplitKeep = 'both' | SplitSide;

/** The dialog-editable options of a `split()` statement. */
export type SplitOptions = {
  /** The pieces to keep: `'both'` (the default) leaves every piece in the scene; `'front'` / `'back'` keep one side only. */
  keep?: SplitKeep;
};

export const SPLIT_KEEP_VALUES: readonly SplitKeep[] = ['both', 'front', 'back'];

/**
 * Splits solids with a plane: each solid the plane crosses is cut into the
 * pieces on either side, every piece a body of its own with a flat cap on
 * the plane. Explicit targets name the bodies to cut, read wherever the
 * features since left them; without targets every solid in scope is a
 * candidate. A solid the plane misses — or only grazes along a face or an
 * edge — is left exactly as it is, with its holder.
 *
 * The plane is consumed for display only, like a mirror's: its quad leaves
 * the screen from here on, and a later feature may take the plane again.
 *
 * `keep` drops the pieces on one side. A dropped piece is never added, so
 * the split's removal record for the source solid lists only the kept
 * pieces as successors and a reference to the source follows them alone.
 */
export class Split extends SceneObject implements ISplit {

  constructor(
    public readonly plane: PlaneObjectBase,
    public readonly targetObjects: SceneObject[] | null = null,
    public readonly options: SplitOptions = {},
  ) {
    super();
  }

  get keep(): SplitKeep {
    return this.options.keep ?? 'both';
  }

  override validate() {
    if (!this.targetObjects) {
      return;
    }
    for (let i = 0; i < this.targetObjects.length; i++) {
      requireShapes(this.targetObjects[i], `target ${i + 1}`, "split");
    }
  }

  build(context: BuildSceneObjectContext) {
    const stock = this.resolveStock(context);

    if (stock.length === 0) {
      throw new BuildError(
        "split has nothing to split — no solid is in scope.",
        "Add material first (e.g. extrude a profile), or move this feature into the part() that owns the solid it should split.",
      );
    }

    this.plane.removeShapes(this);
    // A seed line's sketch is consumed for display, the way an extrude
    // consumes its profile: its wires leave the screen from the split on
    // (the timeline eye brings them back), while every later feature may
    // still read the line.
    if (this.plane instanceof PlaneFromSketchLine) {
      this.plane.line.sketch?.removeShapes(this);
    }
    const plane = this.plane.getPlane();
    if (!plane) {
      // An inline datum (a picked face, a seed line) has no row of its own:
      // its failure is reported here, on the statement that named it.
      const cause = this.plane.getError();
      throw new BuildError(cause ?? "split: the plane it names did not build.");
    }
    this.setState('plane', plane);

    let splitCount = 0;
    for (const { holder, shape } of stock) {
      const { pieces, history } = SplitOps.splitSolidByPlane(shape, plane);
      if (pieces.length === 0) {
        continue;
      }
      splitCount++;

      const kept = pieces
        .filter(piece => this.keep === 'both' || piece.side === this.keep)
        .map(piece => piece.solid);

      holder.removeShape(shape, this, kept);
      if (history) {
        recordModifierHistory(this.keep === 'both' ? history : historyWithin(history, kept), holder, this);
      }
      this.addShapes(kept);
    }

    if (splitCount === 0) {
      this.setError(
        "split: the plane crosses none of the solids — nothing was split.\n" +
        "Hint: move the plane (plane(base, offset), another face) so it passes through the body, " +
        "or pick the solid it should cut as a target.",
      );
    }
  }

  /**
   * The solids this split may cut, each with its holder: the named targets'
   * bodies wherever the features since left them, or — unnamed — every
   * solid the scope's objects hold before this statement.
   */
  private resolveStock(context: BuildSceneObjectContext): HeldShape[] {
    if (this.targetObjects && this.targetObjects.length > 0) {
      const out: HeldShape[] = [];
      const seen = new Set<Shape>();
      for (const obj of this.targetObjects) {
        for (const entry of liveOperandShapes(obj, { excludeMeta: false }, 'solid')) {
          if (!seen.has(entry.shape)) {
            seen.add(entry.shape);
            out.push(entry);
          }
        }
      }
      return out;
    }

    const parent = this.parentId ? this.getParent() : null;
    const objects = parent ? parent.getPreviousSiblings(this) : context.getSceneObjects();
    return heldSolidsOf(objects).map(({ holder, solid }) => ({ holder, shape: solid }));
  }

  /** The cut plane as built. */
  getPlane(): Plane {
    return this.getState('plane') as Plane;
  }

  override getDependencies(): SceneObject[] {
    return [this.plane, ...(this.targetObjects ?? [])];
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    const plane = (remap.get(this.plane) as PlaneObjectBase | undefined) ?? this.plane;
    const targets = this.targetObjects
      ? this.targetObjects.map(obj => remap.get(obj) || obj)
      : null;
    return new Split(plane, targets, { ...this.options });
  }

  compareTo(other: Split): boolean {
    if (!(other instanceof Split)) {
      return false;
    }
    if (!super.compareTo(other)) {
      return false;
    }
    if (!this.plane.compareTo(other.plane)) {
      return false;
    }
    const thisTargets = this.targetObjects || [];
    const otherTargets = other.targetObjects || [];
    if (thisTargets.length !== otherTargets.length) {
      return false;
    }
    for (let i = 0; i < thisTargets.length; i++) {
      if (!thisTargets[i].compareTo(otherTargets[i])) {
        return false;
      }
    }
    return this.keep === other.keep;
  }

  getType(): string {
    return "split";
  }

  getUniqueType(): string {
    return 'split-solid';
  }

  serialize() {
    const plane = this.getPlane();
    return {
      keep: this.keep,
      origin: plane ? [plane.origin.x, plane.origin.y, plane.origin.z] : [0, 0, 0],
      normal: plane ? [plane.normal.x, plane.normal.y, plane.normal.z] : [0, 0, 1],
    };
  }
}

/**
 * The part of a maker history that lands in `solids`: a dropped piece's
 * faces and edges are no scene geometry, so they are neither additions nor
 * the images of a stock face — a stock face whose every image was dropped
 * reads as removed.
 */
function historyWithin(history: ShapeHistory, solids: Solid[]): ShapeHistory {
  const oc = getOC();
  const FACE = oc.TopAbs_ShapeEnum.TopAbs_FACE as TopAbs_ShapeEnum;
  const EDGE = oc.TopAbs_ShapeEnum.TopAbs_EDGE as TopAbs_ShapeEnum;
  const faces = new oc.TopTools_MapOfShape();
  const edges = new oc.TopTools_MapOfShape();
  try {
    for (const solid of solids) {
      for (const raw of Explorer.findShapes(solid.getShape(), FACE)) {
        faces.Add(raw);
      }
      for (const raw of Explorer.findShapes(solid.getShape(), EDGE)) {
        edges.Add(raw);
      }
    }
    const inFaces = (shape: Shape) => faces.Contains(shape.getShape());
    const inEdges = (shape: Shape) => edges.Contains(shape.getShape());
    return {
      addedFaces: history.addedFaces.filter(inFaces),
      modifiedFaces: history.modifiedFaces.map(r => ({ sources: r.sources, results: r.results.filter(inFaces) })),
      generatedFaces: history.generatedFaces.map(r => ({ sources: r.sources, results: r.results.filter(inFaces) })),
      removedFaces: history.removedFaces,
      addedEdges: history.addedEdges.filter(inEdges),
      modifiedEdges: history.modifiedEdges.map(r => ({ sources: r.sources, results: r.results.filter(inEdges) })),
      generatedEdges: history.generatedEdges.map(r => ({ sources: r.sources, results: r.results.filter(inEdges) })),
      removedEdges: history.removedEdges,
    };
  } finally {
    faces.delete();
    edges.delete();
  }
}

import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { Edge, Face, Shape, Solid } from "../common/shapes.js";
import { FilletOps } from "../oc/fillet-ops.js";
import { CleanShapeLineage, ShapeOps } from "../oc/shape-ops.js";
import { ColorTransfer, type CarriedColor } from "../oc/color-transfer.js";
import { requireShapes } from "../common/operand-check.js";
import { recordModifierHistory, trackReplaced } from "../helpers/scene-helpers.js";
import { ShapeHistory } from "../common/shape-history-tracker.js";

export class Chamfer extends SceneObject {
  private _selections: SceneObject[] = [];

  constructor(private distance: number, private distance2: number, private isAngle: boolean = false, ...selections: SceneObject[]) {
    super();
    this._selections = selections;
  }

  get selections(): SceneObject[] {
    return this._selections;
  }

  override validate() {
    for (let i = 0; i < this._selections.length; i++) {
      requireShapes(this._selections[i], `edge selection ${i + 1}`, "chamfer");
    }
  }

  build(context: BuildSceneObjectContext): void {
    let sceneObjects: Map<SceneObject, Shape[]>;

    sceneObjects = new Map<SceneObject, Shape[]>();
    for (const obj of context.getSceneObjects()) {
      const shapes = obj.getShapes({}, 'solid');
      if (shapes.length) {
        sceneObjects.set(obj, shapes);
      }
    }

    let edges: Edge[] = [];
    for (const selection of this.selections) {
      const allEdgeShapes = selection.getShapes();
      for (const shape of allEdgeShapes) {
        if (shape.isEdge()) {
          edges.push(shape as Edge);
        } else {
          // A whole shape contributes its model edges only — no seams (see HiddenEdges).
          edges.push(...(shape.getSubShapes("edge") as Edge[]));
        }
      }
    }

    if (edges.length === 0) {
      this.setError(
        this.selections.length === 0
          ? "chamfer: no edges selected — nothing was chamfered."
          : "chamfer: the selection resolved to no edges — nothing was chamfered.\n" +
            "Hint: a later operation may have removed the selected edges, or the " +
            "filter matched nothing. Re-select on the final model or widen the filter."
      );
    }

    const newShapes = [];

    const shapeObjectMap = new Map<Shape, SceneObject>();
    for (const [obj, shapes] of sceneObjects) {
      if (obj.id === this.parentId) {
        continue;
      }

      for (const shape of shapes) {
        console.log('Chamfer: Mapping shape to object:', shape.getType(), obj.id);
        shapeObjectMap.set(shape, obj);
      }
    }

    const allTargetShapes = Array.from(shapeObjectMap.keys());
    console.log('Chamfer: All target shapes count:', allTargetShapes.length);
    console.log('Fillet: Target shapes count:', allTargetShapes.length);

    for (const shape of allTargetShapes) {
      const solid = shape as Solid;
      console.log('Chamfer: Processing solid:', solid.getType(), solid.id);
      const targetEdges = edges.filter(e => solid.hasEdge(e.getShape()));
      console.log('Fillet: Target edges count:', targetEdges.length);
      if (!targetEdges.length) {
        continue;
      }

      edges = edges.filter(e => !targetEdges.includes(e));

      // An edge between two faces of one surface is a seam a boolean left
      // unmerged, not a corner: the kernel refuses it. Report such edges
      // and chamfer the rest.
      const seams = FilletOps.seamsAmong(solid, targetEdges);
      const breakable = targetEdges.filter(e => !seams.includes(e));
      if (seams.length > 0) {
        this.setError(FilletOps.seamsMessage('chamfer', solid, seams, breakable.length));
      }
      if (breakable.length === 0) {
        continue;
      }

      const obj = shapeObjectMap.get(shape);
      const colors = obj.getFaceColors(solid);
      try {
        let preCleanSolids: Solid[];
        let history: ShapeHistory;
        let carried: CarriedColor[];
        if (!this.distance2) {
          ({ solids: preCleanSolids, history, colors: carried } = FilletOps.makeChamfer({ shape: solid, colors }, breakable, this.distance));
        } else {
          const faces = solid.getFaces();
          const commonFaces: Face[] = [];

          for (const edge of breakable) {
            const firstCommonFace = faces.find(f => f.hasEdge(edge.getShape()));
            if (!firstCommonFace) {
              newShapes.push(shape);
              this.carryFaceColors(obj, shape);
              console.error("Chamfer: Failed to find common face for chamfer.");
              continue;
            }
            commonFaces.push(firstCommonFace);
          }

          ({ solids: preCleanSolids, history, colors: carried } = FilletOps.makeChamferTwoDistances({ shape: solid, colors }, breakable, this.distance, this.distance2, commonFaces, this.isAngle));
        }

        // Clean each chamfer result and chain colors through the cleanup's
        // UnifySameDomain history so any merged faces keep their colors.
        const cleanups: CleanShapeLineage[] = [];
        const chamfered: Solid[] = [];
        try {
          for (const preClean of preCleanSolids) {
            const cleanup = ShapeOps.cleanShapeWithLineage(preClean);
            cleanups.push(cleanup);
            const preCleanView = ColorTransfer.viewOf(carried, preClean);
            try {
              this.recordCarriedColors(ColorTransfer.applyThroughCleanup({ shape: preClean, colors: preCleanView }, cleanup));
            } finally {
              preCleanView.delete();
            }
            const cleaned = cleanup.shape as Solid;
            chamfered.push(cleaned);
            newShapes.push(cleaned);
          }
          obj.removeShape(shape, this, chamfered);
          // The maker history references pre-clean faces/edges — chain it
          // through the same cleanups before they are disposed. The records
          // keep the post-clean images; the pre-clean wrappers the cleanup
          // replaced are nobody's afterwards and are freed here.
          const replaced = new Set<Shape>();
          recordModifierHistory(history, obj, this, cleanups.map(cleanup => trackReplaced(cleanup, replaced)));
          for (const wrapper of replaced) {
            wrapper.dispose();
          }
        } finally {
          for (const cleanup of cleanups) {
            cleanup.dispose();
          }
          // The scene holds the cleaned solids only: the maker's results and
          // the colours carried onto them were read through and are done with.
          for (const preClean of preCleanSolids) {
            preClean.dispose();
          }
          for (const entry of carried) {
            entry.face.dispose();
          }
        }
      } catch {
        // OCCT refused the chamfer (distance too large for the adjacent
        // geometry, a chain ending on a seam, tangency trouble, …). Keep the
        // original solid in the scene, but surface the failure instead of
        // silently skipping it.
        console.error("Fillet: Failed to create chamfer.");
        const value = this.distance2
          ? `a chamfer of ${this.distance} × ${this.distance2}${this.isAngle ? '°' : ''}`
          : `a chamfer of ${this.distance}`;
        this.setError(FilletOps.refusedMessage('chamfer', value, solid, breakable));
        continue;
      } finally {
        colors.delete();
      }
    }

    if (edges.length > 0) {
      this.setError(
        `chamfer: ${edges.length} selected edge(s) matched no solid in the scene ` +
        "and were skipped.\n" +
        "Hint: a later operation may have consumed them — re-select on the final model."
      );
    }

    for (const selection of this.selections) {
      const shapes = selection.getShapes();
      for (const shape of shapes) {
        selection.removeShape(shape, this);
      }
    }

    this.addShapes(newShapes);
  }

  override getDependencies(): SceneObject[] {
    return [...this.selections];
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    const selections = this.selections.map(s => remap.get(s) || s);
    return new Chamfer(this.distance, this.distance2, this.isAngle, ...selections);
  }

  compareTo(other: SceneObject): boolean {
    if (!(other instanceof Chamfer)) {
      return false;
    }

    if (!super.compareTo(other)) {
      return false;
    }

    if (this.distance !== other.distance) {
      return false;
    }

    if (this.distance2 !== other.distance2) {
      return false;
    }

    if (this.isAngle !== other.isAngle) {
      return false;
    }

    if (this.selections.length !== other.selections.length) {
      return false;
    }

    for (let i = 0; i < this.selections.length; i++) {
      if (!this.selections[i].compareTo(other.selections[i])) {
        return false;
      }
    }

    return true;
  }

  getType(): string {
    return "chamfer";
  }

  serialize() {
    return {
      edges: this.selections.map(s => s.serialize()),
      distance: this.distance,
      distance2: this.distance2,
      isAngle: this.isAngle
    }
  }
}

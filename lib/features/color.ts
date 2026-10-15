import { Face } from "../common/face.js";
import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { Shape } from "../common/shape.js";
import { Solid } from "../common/solid.js";
import { SelectSceneObject } from "./select.js";
import { requireShapes } from "../common/operand-check.js";
import { CssColor } from "../common/css-color.js";

export class Color extends SceneObject {
  private _selection: SceneObject | null = null;

  constructor(private color: string, selection?: SceneObject) {
    super();
    this.color = CssColor.toHex(color);
    this._selection = selection ?? null;
  }

  get selection(): SceneObject | null {
    return this._selection;
  }

  override validate() {
    if (this._selection) {
      requireShapes(this._selection, "selection", "color");
    }
  }

  /**
   * Every face this color applies to, grouped by the solid that owns it.
   *
   * A face selection hands us loose faces, whose owner has to be searched for
   * among the scene's solids. Any other scene object hands us whole solids,
   * which contribute all of their faces to an owner we already know.
   *
   * Without an explicit selection we colour every face in the current context,
   * matching `select(face())` followed by `color(...)`: all faces of all
   * non-meta solids present at this point in the build.
   */
  private collectFacesByOwner(candidates: Solid[]): Map<Solid, Face[]> {
    const facesByOwner = new Map<Solid, Face[]>();

    const add = (owner: Solid, face: Face) => {
      let faces = facesByOwner.get(owner);
      if (!faces) {
        faces = [];
        facesByOwner.set(owner, faces);
      }
      faces.push(face);
    };

    if (!this._selection) {
      for (const solid of candidates) {
        if (solid.isMetaShape()) {
          continue;
        }
        facesByOwner.set(solid, solid.getFaces());
      }
      return facesByOwner;
    }

    for (const shape of this._selection.getShapes()) {
      if (shape instanceof Solid) {
        for (const face of shape.getFaces()) {
          add(shape, face);
        }
        continue;
      }

      for (const face of shape.getSubShapes('face') as Face[]) {
        const ownerShape = candidates.find(s => s.hasFace(face.getShape()));
        if (ownerShape) {
          add(ownerShape, face);
        }
        else {
          console.log('Color: Could not find owner shape for face, skipping. Face:', face);
        }
      }
    }

    return facesByOwner;
  }

  build(context: BuildSceneObjectContext) {
    const sceneObjects = context.getSceneObjects();

    const objShapeMap = new Map<Solid, SceneObject>();
    for (const obj of sceneObjects) {
      const shapes = obj.getShapes({ excludeMeta: false }, 'solid');
      for (const shape of shapes) {
        objShapeMap.set(shape as Solid, obj);
      }
    }

    const allShapes = Array.from(objShapeMap.keys());

    const facesByOwner = this.collectFacesByOwner(allShapes);

    // Apply all face colors per solid in a single copy. The copy shares the
    // original's raw handle, so its faces are the original's: the owner's
    // existing records come along first (authors kept — `Solid.copy()`
    // carries geometry only), then this statement's paint on top.
    for (const [ownerShape, faces] of facesByOwner) {
      const newSolid = ownerShape.copy();
      const ownerObj = objShapeMap.get(ownerShape);
      if (ownerObj) {
        this.carryFaceColors(ownerObj, ownerShape, newSolid);
      }
      for (const face of faces) {
        this.recordFaceColor(newSolid, face, this.color, this);
      }

      if (this._selection instanceof SelectSceneObject) {
        for (const face of faces) {
          this._selection.removeShape(face, this);
        }
      }

      if (ownerObj) {
        ownerObj.removeShape(ownerShape, this);
      }

      this.addShape(newSolid);
    }
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    const selection = this._selection ? (remap.get(this._selection) || this._selection) : undefined;
    return new Color(this.color, selection);
  }

  compareTo(other: Color): boolean {
    if (!(other instanceof Color)) {
      return false;
    }

    if (!super.compareTo(other)) {
      return false;
    }

    if (this.color !== other.color) {
      return false;
    }

    if (!this._selection !== !other._selection) {
      return false;
    }

    if (this._selection && other._selection && !this._selection.compareTo(other._selection)) {
      return false;
    }

    return true;
  }

  getType(): string {
    return 'color';
  }

  serialize() {
    return {
    }
  }
}

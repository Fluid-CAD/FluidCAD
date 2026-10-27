import { SceneObject } from "../common/scene-object.js";
import { Face, Shape } from "../common/shapes.js";
import { IDraft } from "../core/interfaces.js";
import { DraftOps } from "../oc/draft-ops.js";
import { requireShapes } from "../common/operand-check.js";
import { recordModifierHistory } from "../helpers/scene-helpers.js";
import { rad } from "../helpers/math-helpers.js";
import { Feature, type FeatureBuildContext } from "../sdk/feature.js";

/** What a draft is constructed from: the angle in degrees, and the face selections it tilts. */
export type DraftValues = {
  angle: number;
  faces: SceneObject[];
};

/**
 * `draft(angle, ...faces)`: tilts the faces by the angle about the bottom
 * of their solid, pulling along +Z — outward for a positive angle, inward
 * for a negative one.
 *
 * The engine's own feature written on the public `Feature` base, as a
 * modifier: it changes the solids that hold the faces directly. Its
 * metadata (`core/draft.ts`) gives it the dialog every custom feature gets.
 */
export class Draft extends Feature<DraftValues> implements IDraft {

  static id = 'draft';

  override validate() {
    const faces = this.values.faces;
    for (let i = 0; i < faces.length; i++) {
      requireShapes(faces[i], `selection ${i + 1}`, "draft");
    }
  }

  override build(context: FeatureBuildContext): void {
    const solids = Draft.solidsOf(context, this.parentId, false);
    if (!solids.size) {
      return;
    }

    const faceRaws = this.shapesOf(this.values.faces).map(face => face.getShape());
    const angle = rad(this.values.angle);
    const newShapes: Shape[] = [];

    for (const [shape, owner] of solids) {
      try {
        const result = DraftOps.applyDraft(shape, faceRaws, angle);

        if (!result) {
          continue;
        }

        newShapes.push(result.shape);
        owner.removeShape(shape, this, [result.shape]);
        recordModifierHistory(result.history, owner, this);
      } catch (e) {
        newShapes.push(shape);
        console.warn("Draft: Failed to apply draft angle.", e);
      }
    }

    for (const sel of this.values.faces) {
      sel.removeShapes(this);
    }

    this.addShapes(newShapes);
  }

  /**
   * The preview: the drafted faces alone, as the draft would tilt them —
   * the solid around them stays as it is, so only what changes is drawn.
   * Nothing in the scene is touched.
   */
  override ghost(context: FeatureBuildContext): Shape[] | null {
    const solids = Draft.solidsOf(context, this.parentId, true);
    const faceRaws = this.shapesOf(this.values.faces).map(face => face.getShape());
    const angle = rad(this.values.angle);
    const faces: Face[] = [];
    for (const shape of solids.keys()) {
      faces.push(...DraftOps.draftedFaces(shape, faceRaws, angle) ?? []);
    }
    if (faces.length === 0) {
      throw new Error("draft(): none of the faces is on a solid the draft can reach");
    }
    return faces;
  }

  /**
   * The solids in reach, each with the object that holds it. A build reads
   * them as they stand — nothing later has built yet. A preview is built
   * after the whole model, so it reads them `asOfReach`: with the reach as
   * the removal scope, each solid as it stood there, not as a later feature
   * (the draft being edited, say) left it.
   */
  private static solidsOf(context: FeatureBuildContext, parentId: string | undefined, asOfReach: boolean): Map<Shape, SceneObject> {
    const objects = context.getSceneObjects();
    const scope = asOfReach ? new Set(objects) : undefined;
    const solids = new Map<Shape, SceneObject>();
    for (const obj of objects) {
      if (obj.id === parentId) {
        continue;
      }
      for (const shape of obj.getShapes({ excludeMeta: false, includeDisplayHidden: asOfReach }, 'solid', scope)) {
        solids.set(shape, obj);
      }
    }
    return solids;
  }
}

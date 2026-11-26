import type { SceneObject } from "../common/scene-object.js";
import type { Shape } from "../common/shape.js";
import type { Face } from "../common/face.js";
import type { BodyShape } from "../common/body-shape.js";
import { Sheet } from "../common/sheet.js";
import { BuildError } from "../common/build-error.js";
import { heldBodiesOf, liveOperandShapes, type HeldBody } from "./live-solids.js";

/** A face with the body that owns it now and the object holding that body. */
export type HeldFace = { face: Face; body: BodyShape | null; holder: SceneObject | null };

/** What a face-like argument can be: one object, or several read as one. */
export type FaceSource = SceneObject | readonly SceneObject[];

/** The faces of an argument that one body owns, with whether they are all of its faces. */
export type BodyFaces = { body: BodyShape; holder: SceneObject; faces: Face[]; whole: boolean };

/**
 * The reader of every face-like argument — what colour paints, what a
 * surface tool offsets or thickens. One place decides what an object stands
 * for as faces and which body owns each:
 *
 * - a face selection (`select(face()…)`, `e.endFaces()`): its faces, each
 *   matched to the body in scope that has it;
 * - a solid or a surface (the object that built it): every face of each body
 *   it stands for, followed through the features since (`liveOperandShapes`);
 * - a face no body in scope owns: the face alone, with no owner;
 * - edges, a sketch or a curve: refused, naming what was given.
 *
 * Meta shapes (a plane datum's quad) never count.
 */
export class FaceOperand {
  /** Every face the argument stands for, each with its owner, in argument order and each face once. */
  static faces(source: FaceSource, scope: SceneObject[], label: string): HeldFace[] {
    let held: HeldBody[] | null = null;
    const owned = (face: Face): HeldBody | undefined => {
      held ??= heldBodiesOf(scope);
      return held.find(({ body }) => (body as BodyShape).hasFace(face.getShape()));
    };

    const out: HeldFace[] = [];
    const seen = new Set<Face>();
    const add = (entry: HeldFace) => {
      if (!seen.has(entry.face)) {
        seen.add(entry.face);
        out.push(entry);
      }
    };

    for (const obj of FaceOperand.objectsOf(source)) {
      for (const { holder, shape } of liveOperandShapes(obj)) {
        if (shape.isBody()) {
          const body = shape as BodyShape;
          for (const face of body.getFaces()) {
            add({ face, body, holder });
          }
        } else if (shape.isFace()) {
          const face = shape as Face;
          const owner = owned(face);
          add(owner
            ? { face, body: owner.body as BodyShape, holder: owner.holder }
            : { face, body: null, holder: null });
        } else {
          throw FaceOperand.notFaces(obj, shape, label);
        }
      }
    }
    return out;
  }

  /**
   * The argument's faces grouped by owning body, bodies in scene order (their
   * holders' order, then each body's place in its holder). `whole` is true
   * when the argument names every face of the body — the body itself, or a
   * selection of all its faces. A face no body in scope owns is an error.
   */
  static byBody(source: FaceSource, scope: SceneObject[], label: string): BodyFaces[] {
    const groups = new Map<BodyShape, BodyFaces>();
    for (const { face, body, holder } of FaceOperand.faces(source, scope, label)) {
      if (!body || !holder) {
        throw new BuildError(
          `${label}: no solid or surface in scope holds a selected face.`,
          `Select faces of a body that exists at this point — a body a later feature builds, or one in another part, is not in scope here.`,
        );
      }
      let group = groups.get(body);
      if (!group) {
        group = { body, holder, faces: [], whole: false };
        groups.set(body, group);
      }
      group.faces.push(face);
    }
    const rank = (group: BodyFaces) => [group.holder.getOrder(), group.holder.getAddedShapes().indexOf(group.body)];
    return [...groups.values()]
      .map(group => ({ ...group, whole: group.faces.length === group.body.getFaces().length }))
      .sort((a, b) => {
        const [aOrder, aIndex] = rank(a);
        const [bOrder, bIndex] = rank(b);
        return aOrder - bOrder || aIndex - bIndex;
      });
  }

  /** Whole surfaces only: a BuildError when the argument names a solid or part of a surface. */
  static sheets(source: FaceSource, scope: SceneObject[], label: string): Array<{ sheet: Sheet; holder: SceneObject }> {
    return FaceOperand.byBody(source, scope, label).map(({ body, holder, faces, whole }) => {
      if (!(body instanceof Sheet)) {
        throw new BuildError(
          `${label} is a solid; it needs a surface.`,
          `Pass a surface, or the object that built one.`,
        );
      }
      if (!whole) {
        throw new BuildError(
          `${label} names ${faces.length} of the ${body.getFaces().length} faces of a surface; it needs the whole surface.`,
          `Pass the object that built the surface, or select every one of its faces.`,
        );
      }
      return { sheet: body, holder };
    });
  }

  private static objectsOf(source: FaceSource): readonly SceneObject[] {
    return Array.isArray(source) ? source : [source as SceneObject];
  }

  /** The refusal of an argument that holds something other than faces or bodies. */
  private static notFaces(obj: SceneObject, shape: Shape, label: string): BuildError {
    const given = obj.getType() === 'sketch'
      ? 'a sketch'
      : shape.isEdge() && (obj.isSelection() || obj.isLazy())
        ? 'an edge selection'
        : shape.isEdge() || shape.isWire()
          ? 'a curve'
          : `a ${shape.getType()}`;
    return new BuildError(
      `${label} is ${given}; it needs faces.`,
      `Pass a face selection such as select(face()…), or the solid or surface that holds the faces.`,
    );
  }
}

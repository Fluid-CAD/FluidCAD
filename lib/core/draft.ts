import { Draft, type DraftValues } from "../features/draft.js";
import { SceneObject } from "../common/scene-object.js";
import { registerBuilder, SceneParserContext } from "../index.js";
import { ISceneObject, IDraft } from "./interfaces.js";
import { type NumberParam } from "./param.js";
import { FeatureMetas, type FeatureMeta } from "../sdk/meta.js";

interface DraftFunction {
  /**
   * Applies a draft angle to the last selected faces.
   * @param angle - The draft angle in degrees
   */
  (angle: NumberParam): IDraft;
  /**
   * Applies a draft angle to the given face selections.
   * @param angle - The draft angle in degrees
   * @param selections - The face selections to draft
   */
  (angle: NumberParam, ...selections: ISceneObject[]): IDraft;
}

/** The angle a statement that writes none drafts by. */
const DEFAULT_ANGLE = 5;

/**
 * Draft, described the way a custom feature describes itself: the editor's
 * catalog finds it in `fluidcad/core` and gives it a toolbar button, a
 * dialog, a preview and timeline editing — with no Draft-specific code in
 * the editor.
 */
const DRAFT_FEATURE: FeatureMeta = {
  class: Draft,
  label: 'Draft',
  description: 'Tilts faces by an angle about the bottom of their solid — outward for a positive angle, inward for a negative one.',
  group: 'modify',
  kind: 'modifier',
  params: {
    angle: { type: 'angle', label: 'Angle', default: DEFAULT_ANGLE },
    faces: { picker: 'face', label: 'Faces', multiple: true },
  },
  call: ['angle', '...faces'],
};

function build(context: SceneParserContext): DraftFunction {
  return function draft() {
    const args: unknown[] = Array.from(arguments);

    // `draft(e.sideFaces())` leaves the angle out: it drafts by the default.
    if (args[0] instanceof SceneObject) {
      args.unshift(undefined);
    }

    // `draft(5)` drafts the last selection.
    if (args.length < 2) {
      const implicit = context.getLastSelection();
      if (implicit) {
        if (args.length === 0) {
          args.push(undefined);
        }
        args.push(implicit);
      }
    }

    let feature: Draft;
    if (args.length < 2) {
      // Nothing to draft: the statement fails on its own row, and the rest
      // of the model still builds.
      const angle = typeof args[0] === 'number' ? args[0] : DEFAULT_ANGLE;
      feature = new Draft({ angle, faces: [] });
      feature.refuse('draft() has no faces to draft — pass them, as in draft(5, e.sideFaces()), or select them just before');
    } else {
      feature = new Draft(FeatureMetas.values(FeatureMetas.resolve(DRAFT_FEATURE, true), args) as DraftValues);
    }
    return feature.addTo(context);
  } as DraftFunction;
}

export default registerBuilder(build, { feature: DRAFT_FEATURE, builtIn: true });

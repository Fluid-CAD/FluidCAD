import { SceneIndex } from '../../helpers/scene-index';
import { SceneObjectRender } from '../../types';


/**
 * A pick option's consumer: the display name of the feature that hid the
 * option's sketch, plane or axis in this world (`consumedBy`), for the option
 * label and the dialog's reveal of the pick. Undefined while the object still
 * renders.
 */
export function consumerName(obj: SceneObjectRender, sceneObjects: SceneObjectRender[]): string | undefined {
  if (obj.consumedBy === undefined) {
    return undefined;
  }
  return SceneIndex.of(sceneObjects).byId(obj.consumedBy)?.name || 'a feature';

}

/** "s2 · used by Extrude" for a consumed option; the plain name otherwise. */
export function consumedLabel(name: string, consumer: string | undefined): string {
  return consumer ? `${name} · used by ${consumer}` : name;
}

/** Whether the row carries hidden shapes with meshes — what draws when it is shown again. */

export function hasHiddenMeshes(obj: SceneObjectRender): boolean {
  return (obj.hiddenShapes ?? []).some(s => (s.meshes?.length ?? 0) > 0);
}

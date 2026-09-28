import type { ParamVal } from '../../../lib/dist/index.js';
import type { SourceLocation } from '../../../lib/dist/common/scene-object.js';

/**
 * One `property()` declaration of the rendered file, as the parameters
 * panel lists it: the name and the value the last render computed, where
 * the call was authored, and the `part()` statement whose body declared it
 * — what the panel's Part dropdown filters on.
 */
export type ScenePropertyDefinition = {
  name: string;
  value: ParamVal;
  sourceLocation?: SourceLocation;
  part: SourceLocation;
};

/** The slice of a rendered Part this reads — duck-typed across module copies. */
type PartLike = {
  getType?: () => string;
  getSourceLocation?: () => SourceLocation | null;
  getProperties?: () => { name: string; value: ParamVal; sourceLocation?: SourceLocation }[];
};

function stripVirtual(location: SourceLocation): SourceLocation {
  return { ...location, filePath: location.filePath.replace('virtual:live-render:', '') };
}

/**
 * Every property of every part the scene built, in build order. Only a part
 * the render located can carry properties the panel can edit, so parts
 * without a source location are skipped. Duck-typed on `getType() === 'part'`
 * like every other server read of a workspace's own fluidcad objects.
 */
export function collectSceneProperties(scene: { getAllSceneObjects?: () => unknown[] }): ScenePropertyDefinition[] {
  const out: ScenePropertyDefinition[] = [];
  const objects = scene.getAllSceneObjects?.() ?? [];
  for (const candidate of objects) {
    const part = candidate as PartLike;
    if (typeof part.getType !== 'function' || part.getType() !== 'part' || typeof part.getProperties !== 'function') {
      continue;
    }
    const partLocation = part.getSourceLocation?.() ?? null;
    if (!partLocation) {
      continue;
    }
    for (const property of part.getProperties()) {
      const def: ScenePropertyDefinition = {
        name: property.name,
        value: property.value,
        part: stripVirtual(partLocation),
      };
      if (property.sourceLocation) {
        def.sourceLocation = stripVirtual(property.sourceLocation);
      }
      out.push(def);
    }
  }
  return out;
}

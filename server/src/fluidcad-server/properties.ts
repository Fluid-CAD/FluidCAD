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

/**
 * The default variant of one `part()` definition the render built, with
 * the `property()` values that variant published — what a `part()`
 * binding reads as `def.properties.<name>`. Located at the `part()` call.
 */
export type RenderedPartProperties = {
  sourceLocation: SourceLocation;
  properties: Record<string, ParamVal>;
};

/** The slice of a rendered Part this reads — duck-typed across module copies. */
type PartLike = {
  getType?: () => string;
  getSourceLocation?: () => SourceLocation | null;
  getProperties?: () => { name: string; value: ParamVal; sourceLocation?: SourceLocation }[];
  /** The variant's parameter interface — set on a scoped (insert-path) build only. */
  params?: { label: string; defaultValue: ParamVal; currentValue: ParamVal }[];
};

/** Whether a scene object is a rendered Part with properties to read. */
function asPart(candidate: unknown): (PartLike & { getProperties: NonNullable<PartLike['getProperties']> }) | null {
  const part = candidate as PartLike;
  if (typeof part.getType !== 'function' || part.getType() !== 'part' || typeof part.getProperties !== 'function') {
    return null;
  }
  return part as PartLike & { getProperties: NonNullable<PartLike['getProperties']> };
}

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
    const part = asPart(candidate);
    if (!part) {
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

/** Whether two parameter values are the same value — arrays (a multi-select) element-wise. */
function sameParamValue(a: ParamVal, b: ParamVal): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);
  }
  return a === b;
}

/**
 * Whether a rendered Part is its definition's DEFAULT variant — the one
 * `def.properties` reads. The entry-file pass builds a definition
 * unscoped, leaving `params` unset; an insert-path build is scoped and
 * records the parameter interface it resolved, so it is the default
 * variant exactly when no parameter left its default.
 */
function isDefaultVariant(part: PartLike): boolean {
  if (!part.params) {
    return true;
  }
  return part.params.every((param) => sameParamValue(param.currentValue, param.defaultValue));
}

/**
 * The default variant of every `part()` definition the scene built, by the
 * definition's call, in build order — the properties a `part()` binding
 * reads as `def.properties.<name>`. A definition the render did not locate
 * has no call to bind to and is skipped; so is a variant an override
 * shaped, whose values are its own instance's (`instance.properties`).
 * Read from what the render already built — nothing here materializes.
 */
export function collectRenderedPartProperties(scene: { getAllSceneObjects?: () => unknown[] }): RenderedPartProperties[] {
  const out: RenderedPartProperties[] = [];
  const objects = scene.getAllSceneObjects?.() ?? [];
  for (const candidate of objects) {
    const part = asPart(candidate);
    if (!part || !isDefaultVariant(part)) {
      continue;
    }
    const partLocation = part.getSourceLocation?.() ?? null;
    if (!partLocation) {
      continue;
    }
    const properties: Record<string, ParamVal> = {};
    for (const property of part.getProperties()) {
      properties[property.name] = property.value;
    }
    out.push({ sourceLocation: stripVirtual(partLocation), properties });
  }
  return out;
}

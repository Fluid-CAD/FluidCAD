import { registerBuilder, type SceneParserContext } from "../index.js";
import type { Feature } from "./feature.js";
import type { FeatureArgs, FeatureCallShape, FeatureParams } from "./feature-params.js";
import { FeatureMetas, type FeatureMeta } from "./meta.js";

/** A feature class `defineFeature()` takes: one that declares its values, through `Feature.with()`. */
export type DefinableFeatureClass = (abstract new (values: any) => Feature<any>) & { readonly id: string; readonly params: FeatureParams };

/**
 * What `defineFeature()` is told about a feature: its metadata, less what
 * the class carries — the class itself, its values and its kind — with a
 * call shape over the class's values.
 */
export type DefineFeatureMeta<P extends FeatureParams = FeatureParams> =
  Omit<FeatureMeta, 'class' | 'params' | 'kind' | 'call'> & {
    call: FeatureCallShape<P>;
    /** Leave it out: the class is `defineFeature()`'s first argument. */
    class?: never;
    /** Leave them out: the values are the class's own, declared with `Feature.with()`. */
    params?: never;
    /** Leave it out: it is read from the class — one that implements `buildTool()` is a tool, one that overrides `build()` a modifier. */
    kind?: never;
  };

/**
 * The builder of a feature class that declares its values with
 * `Feature.with()`: the function a model calls, which reads its arguments
 * by the call shape, checks each value against its declaration, fills the
 * defaults and adds the feature to the scene. Its metadata gives the
 * feature its toolbar button and dialog.
 *
 * ```js
 * export const standoff = defineFeature(Standoff, {
 *   label: 'Standoff', group: 'create', operations: ['add', 'new'],
 *   call: ['face', { height: 'height', outer: 'outer', hole: 'hole' }],
 * });
 * ```
 *
 * The call names the class's values, so a misspelled one is an error in
 * the editor, and the builder's arguments are typed from it:
 * `standoff(e.endFaces(), { height: 12 })`. The kind is read from the
 * class — a tool implements `buildTool()`, a modifier overrides `build()`.
 */
export function defineFeature<C extends DefinableFeatureClass, const S extends FeatureCallShape<C['params']>>(
  featureClass: C,
  meta: Omit<DefineFeatureMeta<C['params']>, 'call'> & { call: S },
): (...args: FeatureArgs<C['params'], S>) => InstanceType<C> {
  const full = FeatureMetas.define(featureClass, meta);
  const FeatureClass = featureClass as unknown as new (values: unknown) => Feature;
  return registerBuilder((context: SceneParserContext) =>
    (...args: unknown[]) => new FeatureClass(FeatureMetas.values(FeatureMetas.resolve(full), args)).addTo(context),
  { feature: full }) as (...args: FeatureArgs<C['params'], S>) => InstanceType<C>;
}

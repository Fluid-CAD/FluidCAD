/**
 * The version of the custom-feature SDK this engine speaks: the surface a
 * package's feature and part modules are written against (`fluidcad/sdk`,
 * its metadata vocabulary, `fluidcad/sdk/kernel`, `fluidcad/sdk/occt`).
 *
 * A package records the SDK version it was packed against beside the
 * lowest engine it supports (`minEngine`), and an engine outside that range
 * refuses the package with a sentence naming both versions (packages K10) —
 * rather than failing later with a confusing "unknown field" from the
 * metadata validator.
 *
 * Bump it on a breaking SDK change only: a removed or renamed export, a
 * metadata field or call shape an older engine cannot read, a changed
 * meaning of a value. Adding an optional field an older engine may safely
 * reject is not breaking. It is an integer, not the engine's version, so
 * engine releases that leave the SDK alone never strand a package.
 */
export const SDK_VERSION = 1;

/**
 * The first FluidCAD version whose engine speaks {@link SDK_VERSION}: the
 * lowest `minEngine` a package packed against this SDK may declare.
 * `fluidcad pack` refuses an older one, so a package's `minEngine` alone
 * says which FluidCAD it needs (hub-plan H11 decision 3: the SDK ships
 * with the engine, so "Requires FluidCAD X+" is the one message an
 * incompatible package needs).
 *
 * Set it to the new engine's version whenever `SDK_VERSION` is bumped. For
 * SDK 1 it is 0.0.45: the branch's engines reported 0.0.45 when the
 * `fluidcad/sdk` surface (the `Feature` base, `registerBuilder` metadata)
 * first appeared on 2026-10-03, before `SDK_VERSION` named it on
 * 2026-10-09, and every package packed since declares 0.0.45 or later.
 */
export const SDK_SINCE = '0.0.45';

/**
 * The minor revision of SDK {@link SDK_VERSION}: bumped when the SDK gains
 * something an older engine of the same SDK lacks — a new export, a new
 * option — without breaking what was there. A package and an engine of one
 * `SDK_VERSION` stay compatible whatever their minor revisions; a package
 * that uses an addition runs only on an engine that has it, so it declares
 * a `minEngine` no older than the FluidCAD that shipped the revision
 * ({@link SDK_MINOR_SINCE}).
 *
 * - 0: the SDK as {@link SDK_SINCE} shipped it.
 * - 1: `definePart` (a part made by running a feature, inserted with its
 *   values by id), named frames (`Feature.with(params, { frames })`,
 *   `this.setFrames()`, `feature.frame(name)`), and generated assemblies
 *   (`Generator`, `defineAssembly`: a sub-assembly made by code, inserted
 *   with its values by id).
 */
export const SDK_MINOR = 1;

/**
 * The first FluidCAD version whose engine speaks {@link SDK_MINOR}: the
 * lowest `minEngine` a package using what that revision added may declare.
 * Set it to the new engine's version whenever `SDK_MINOR` is bumped.
 */
export const SDK_MINOR_SINCE = '0.0.49';

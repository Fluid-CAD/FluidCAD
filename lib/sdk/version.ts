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

/**
 * fluidcad/browser — the engine surface a browser viewer embeds in a Web
 * Worker. Everything here is browser-safe by construction: no Node builtins
 * on any import path (the bundler supplies inert stubs for lib's fs/font
 * touchpoints, which are unreached once an AssetProvider is installed).
 */
export { BrowserEngineHost, detectSceneKind, type ModuleEvaluator } from "./host.js";
export { VIEWER_PROTOCOL_VERSION } from "./types.js";
export type { BrowserRenderResult, BrowserObjectBuildError, BrowserSceneKind, BrowserSerializedAssembly, EngineInfo } from "./types.js";
export { ENGINE_NAMESPACE_SPECIFIERS, installEngineNamespaces, engineShimModuleSource } from "./linking.js";
export { BLOCKED_NODE_MODULES, getBlockedNodeModule } from "./blocked-imports.js";
export { getMaterials } from "../common/materials.js";
export type { Material } from "../common/materials.js";

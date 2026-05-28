/**
 * Programmatic API surface, published as `fluidcad/server/api`.
 *
 * This is the ONLY entry point downstream consumers (the private hub repo,
 * future tooling) are meant to import from. It re-exports the engine wrapper,
 * the SceneHost extension seam, the HTTP/WS plumbing, the read-only route
 * factories, the wire protocol types, and the model-package packer + types.
 *
 * Note: `fluidcad/server` (no `/api`) still resolves to the desktop server
 * BINARY (`./index.ts`), which boots Express + a WebSocket server at import
 * time — the editor extensions `fork()` that. THIS module, by contrast, has
 * NO side effects; import it freely from a library context.
 *
 * Anything a consumer needs that isn't exported here is a deliberate decision:
 * either add it to this surface on purpose, or reimplement it downstream. Keep
 * hub-specific concerns OUT of this file and out of the public repo.
 */

// --- Engine -----------------------------------------------------------------
export { FluidCadServer } from './fluidcad-server.ts';
export type {
  SceneRenderedData,
  SceneSummary,
  SceneSummaryObject,
  ShapeList,
  ShapeListEntry,
} from './fluidcad-server.ts';

// --- SceneHost extension point ---------------------------------------------
// Third parties (e.g. a hub runtime) implement `SceneHost` to feed scene code
// from somewhere other than the local filesystem.
export type { SceneHost } from './host/scene-host.ts';
export { LocalSceneHost } from './host/local-scene-host.ts';
export { BLOCKED_NODE_MODULES, getBlockedNodeModule } from './host/blocked-imports.ts';

// --- Server plumbing --------------------------------------------------------
export { createServerCore } from './server-core.ts';
export type { ServerCore, UIClient } from './server-core.ts';

// --- Read-only route factories ---------------------------------------------
// The subset a viewer-style server may safely mount. Mutating routers
// (params, timeline, sketch-edits, editor, render, lint, export, pack) are
// intentionally NOT exported — a read-only host should not be able to reach
// for them by accident.
export { createHealthRouter } from './routes/health.ts';
export type { HealthInfo } from './routes/health.ts';
export { createSceneRouter } from './routes/scene.ts';
export type { CameraStateGetter } from './routes/scene.ts';
export { createHitTestRouter } from './routes/hit-test.ts';
export { createScreenshotRouter } from './routes/screenshot.ts';
export { createPreferencesRouter } from './routes/preferences.ts';

// --- Wire protocol (types only) --------------------------------------------
export type * from './ws-protocol.ts';

// --- Model package: packer + types -----------------------------------------
// `packModel` is already public via the `fluidcad pack` CLI; exposing it here
// lets a hub backend pack uploads programmatically instead of shelling out.
// NOTE: there is no `unpackModel` here on purpose — unpacking is a hub concern
// and lives in the private repo.
export { packModel } from './model-package/pack.ts';
export type { PackInputs, PackResult } from './model-package/pack.ts';
export type {
  ModelPackageManifest,
  ModelPackageCamera,
  ParamValue,
} from './model-package/types.ts';
export {
  MANIFEST_FILENAME,
  BUNDLE_FILENAME,
  SOURCES_PREFIX,
  ASSETS_PREFIX,
} from './model-package/types.ts';

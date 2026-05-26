export type ParamValue = string | number | boolean | (string | number)[];

export interface ModelPackageCamera {
  position: [number, number, number];
  target: [number, number, number];
  up: [number, number, number];
  projection: 'orthographic' | 'perspective';
}

/**
 * Contents of `manifest.json` inside a `.fluidpkg` archive. The bundle, the
 * optional init.js, and any STEP assets live alongside this manifest as
 * separate entries in the zip — we never base64-embed binaries in JSON.
 *
 * Phase 2's HubSceneHost reads this manifest first to decide what else to
 * load from the archive (presence of `init.js`, which asset paths to map).
 */
export interface ModelPackageManifest {
  schemaVersion: 1;
  name: string;
  description?: string;
  fluidcadVersion: string;
  createdAt: string;
  entry: string;
  /**
   * True when the workspace had an `init.js`. Its code is bundled at the
   * top of `bundle.js` so the engine pipeline is set up before the entry
   * runs, and the bundle's `default` export is init's default (the
   * SceneManager). The original `init.js` text is still preserved under
   * `src/init.js` for display.
   */
  hasInit: boolean;
  /**
   * Workspace-relative paths of every `.fluid.js` / `.js` source file the
   * entry transitively imports (entry itself included). The original text of
   * each lives under `src/<path>` in the archive. Lets the hub UI offer a
   * file tree where viewers can read individual sources, separate from the
   * bundled `bundle.js` that the engine actually executes.
   *
   * npm dependencies are NOT included here — esbuild inlines them into
   * `bundle.js`, and shipping their on-disk paths would leak `node_modules`.
   */
  sources: string[];
  assets: string[];
  params?: Record<string, ParamValue>;
  camera?: ModelPackageCamera;
}

/**
 * Standard layout inside a `.fluidpkg` zip:
 *   manifest.json    — ModelPackageManifest as JSON
 *   bundle.js        — esbuild ES module output: init.js code first (if
 *                      hasInit), then the entry; bundle's default export
 *                      is init's default (SceneManager) when present
 *   src/<path>       — original source text for each workspace file the
 *                      entry imports (for display in the hub file tree)
 *   assets/<path>    — raw bytes of imported STEP files, paths preserved
 *                      relative to the workspace root
 */
export const MANIFEST_FILENAME = 'manifest.json';
export const BUNDLE_FILENAME = 'bundle.js';
export const SOURCES_PREFIX = 'src/';
export const ASSETS_PREFIX = 'assets/';

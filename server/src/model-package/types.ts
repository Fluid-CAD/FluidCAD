import type { ParamDefinition } from '../../../lib/dist/index.js';

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
 * The HubSceneHost reads this manifest first to decide what else to load from
 * the archive (presence of `init.js`, which asset paths to map, the file tree).
 *
 * `schemaVersion: 2` retired the `src/` source tree: the single self-contained
 * `bundle.js` is what the engine executes, and the `files` tree (below) is the
 * full human-readable project the hub displays — so `sources`/`src/` (the old
 * transitive-import subset) is gone.
 */
export interface ModelPackageManifest {
  schemaVersion: 2;
  name: string;
  description?: string;
  fluidcadVersion: string;
  createdAt: string;
  entry: string;
  /**
   * True when the workspace had an `init.js`. Its code is bundled at the top of
   * `bundle.js` so the engine pipeline is set up before the entry runs, and the
   * bundle's `default` export is init's default (the SceneManager). The original
   * `init.js` text is still in the `files` tree for display.
   */
  hasInit: boolean;
  assets: string[];
  /**
   * Workspace-relative paths of every non-ignored file in the workspace
   * (Pack v2), shipped verbatim under `files/<path>`. The full human tree —
   * README, package.json, configs, the `.fluid.js` sources — that the hub's
   * file viewer lists and serves, separate from the self-contained `bundle.js`
   * the engine executes. Paths already shipped under `assets/` (engine
   * brep/STEP) are NOT repeated here; `files` + `assets` is the whole package.
   *
   * Selection respects a root `.gitignore` (via the `ignore` package) and
   * always excludes `node_modules`, prior `*.fluidpkg` outputs, `fluidcad.json`
   * (the local hub binding), and every hidden dot-entry (`.git`, `.env`,
   * `.claude`, `.vscode`, … — never model content, may hold secrets), whether or
   * not they're gitignored.
   */
  files: string[];
  params?: Record<string, ParamValue>;
  /**
   * Full parameter schema captured by rendering the model once at pack time
   * (type/default/current value/constraints per `param()` call). Unlike
   * `params` (override VALUES only), this is the complete definition set the
   * hub stores and renders forms from. Populated by `fluidcad publish` (which
   * boots the engine to render); plain `fluidcad pack` leaves it undefined.
   */
  paramDefinitions?: ParamDefinition[];
  camera?: ModelPackageCamera;
}

/**
 * Standard layout inside a `.fluidpkg` zip:
 *   manifest.json    — ModelPackageManifest as JSON
 *   bundle.js        — esbuild ES module output: init.js code first (if
 *                      hasInit), then the entry; bundle's default export
 *                      is init's default (SceneManager) when present
 *   assets/<path>    — raw bytes of imported STEP files, paths preserved
 *                      relative to the workspace root
 *   files/<path>     — every non-ignored workspace file (Pack v2), verbatim;
 *                      the full human tree the hub viewer lists and serves.
 *                      Excludes anything already under assets/ to avoid
 *                      duplicate bytes.
 */
export const MANIFEST_FILENAME = 'manifest.json';
export const BUNDLE_FILENAME = 'bundle.js';
export const ASSETS_PREFIX = 'assets/';
export const FILES_PREFIX = 'files/';

// Node-only lookup of a project's unit in `fluidcad.json`. Imports `fs`
// directly like lib/io/file-import.ts: the browser bundle stubs the module,
// and every entry point here bails out first when there is no `process`.

import * as fs from "fs";
import { dirname, join, sep } from "path";
import { DEFAULT_LENGTH_UNIT, parseLengthUnit } from "./units/units.js";
import type { LengthUnit } from "./units/units.js";
import type { FluidCADOptions } from "./index.js";

export const PROJECT_CONFIG_FILENAME = "fluidcad.json";

function isNode(): boolean {
  return typeof process !== "undefined" && typeof fs.readFileSync === "function";
}

/**
 * The `unit` key of `<dir>/fluidcad.json`: null when the file or the key is
 * absent. An unusable value is reported and ignored rather than failing the
 * render — the file's other keys (the engine pin) stay meaningful.
 */
export function readProjectUnit(dir: string): LengthUnit | null {
  if (!isNode() || !dir) {
    return null;
  }
  const configPath = join(dir, PROJECT_CONFIG_FILENAME);
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn(`${configPath} is not valid JSON; ignoring its unit.`);
    return null;
  }
  const unit = parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>).unit : undefined;
  if (unit === undefined || unit === null) {
    return null;
  }
  try {
    return parseLengthUnit(unit);
  } catch (error) {
    console.warn(`${configPath}: ${(error as Error).message} Ignoring it.`);
    return null;
  }
}

/** init({ unit }) → <workspace>/fluidcad.json "unit" (Node only) → mm. */
export function resolveProjectUnit(workspacePath: string, options?: FluidCADOptions): LengthUnit {
  if (options?.unit !== undefined) {
    return parseLengthUnit(options.unit);
  }
  return readProjectUnit(workspacePath) ?? DEFAULT_LENGTH_UNIT;
}

function isNodeModulesPackageRoot(dir: string): boolean {
  if (!dir.split(/[\\/]/).includes("node_modules")) {
    return false;
  }
  try {
    return fs.existsSync(join(dir, "package.json"));
  } catch {
    return false;
  }
}

function sameDir(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/[\\/]+$/, "").replace(/\\/g, "/");
  return norm(a) === norm(b);
}

/**
 * The nearest `fluidcad.json` unit walking UP from a file's directory,
 * stopping at the workspace root or at a package root inside node_modules
 * (a published part library carries its own project unit). Results are
 * cached per hook instance, i.e. per registry / render.
 */
export function createProjectUnitLookup(rootPath: string): ((file: string) => LengthUnit | null) | undefined {
  if (!isNode()) {
    return undefined;
  }
  const cache = new Map<string, LengthUnit | null>();
  const lookup = (dir: string): LengthUnit | null => {
    const cached = cache.get(dir);
    if (cached !== undefined) {
      return cached;
    }
    let result = readProjectUnit(dir);
    const parent = dirname(dir);
    const atBoundary = (rootPath && sameDir(dir, rootPath)) || isNodeModulesPackageRoot(dir) || parent === dir;
    if (result === null && !atBoundary) {
      result = lookup(parent);
    }
    cache.set(dir, result);
    return result;
  };
  return (file: string) => {
    if (!file || !(file.startsWith("/") || /^[A-Za-z]:/.test(file))) {
      return null;
    }
    return lookup(dirname(file.replace(/\//g, sep)));
  };
}

import fs from 'fs';
import path from 'path';
import { PackageFields, type PackageDependencies, type PackageInfo, type PackagePin } from './packages/package-fields.ts';

/**
 * The project descriptor at a workspace root:
 *
 * ```json
 * { "engine": "0.0.41", "unit": "in" }
 * ```
 *
 * The pin records which FluidCAD engine a project's geometry was authored
 * against; `unit` is the project's document unit (what a file without its
 * own `unit()` statement, and every assembly, is measured in). Nothing here
 * re-execs a different version — that is the desktop shell's job. What the pin buys today is that `npx fluidcad serve`, which
 * resolves to *latest* whenever the npx cache turns over, can say so out loud
 * instead of silently rebuilding a model on a kernel it has never seen.
 *
 * A package workspace adds its identity under `package`, and a project its
 * package pins under `dependencies` (packages plan, Stage P2):
 *
 * ```json
 * {
 *   "engine": "0.0.46",
 *   "package": { "name": "@acme/gears", "version": "1.2.0" },
 *   "dependencies": { "@acme/fasteners": { "version": "2.0.1", "integrity": "sha256-…" } }
 * }
 * ```
 *
 * Deliberately dependency-free (node builtins, and the import-free modules
 * under `packages/` that validate the package keys): this module is imported
 * by the server (TS) and, as compiled JS out of `server/dist`, by the plain-JS
 * CLI in `bin/`.
 */

export type { PackageDependencies, PackageInfo, PackagePin } from './packages/package-fields.ts';

/** `package.json` is supported as an alternative home for the same pin. */
export type EnginePinSource = 'fluidcad.json' | 'package.json';

/**
 * The length units a document can be authored in. Kept as a local union
 * rather than imported from `fluidcad` so this module stays dependency-free
 * (see above) and so the CLI can validate `--unit` against a workspace whose
 * engine predates units; the lib's `LengthUnit` is the identical union.
 */
export type LengthUnit = 'mm' | 'cm' | 'm' | 'in' | 'ft';

export const LENGTH_UNITS: readonly LengthUnit[] = ['mm', 'cm', 'm', 'in', 'ft'];

/**
 * The density units a project material may declare — the lib's
 * `DensityUnit` verbatim, local for the same dependency-free reason as
 * `LengthUnit`.
 */
export type DensityUnit = 'g/cm³' | 'kg/m³' | 'g/mm³' | 'lbs/in³';

export const DENSITY_UNITS: readonly DensityUnit[] = ['g/cm³', 'kg/m³', 'g/mm³', 'lbs/in³'];

/**
 * One entry of the `materials` map (the lib's `ProjectMaterial`):
 *
 * ```json
 * { "materials": { "alloy-steel": { "name": "Alloy Steel", "density": 7.7, "densityUnit": "g/cm³" } } }
 * ```
 *
 * `densityUnit` is optional and defaults to g/cm³ downstream. The map is
 * keyed by the id `part(...).material(id)` refers to; an entry reusing a
 * built-in `fluidcad-…` id overrides that built-in.
 */
export type ProjectMaterial = {
  name: string;
  density: number;
  densityUnit?: DensityUnit;
};

export type ProjectMaterials = Record<string, ProjectMaterial>;

/**
 * Accepted spellings, lower-cased. The long forms exist because a config file
 * is typed by hand; the short codes are what everything downstream stores.
 */
const UNIT_ALIASES: Record<string, LengthUnit> = {
  mm: 'mm', millimeter: 'mm', millimeters: 'mm', millimetre: 'mm', millimetres: 'mm',
  cm: 'cm', centimeter: 'cm', centimeters: 'cm', centimetre: 'cm', centimetres: 'cm',
  m: 'm', meter: 'm', meters: 'm', metre: 'm', metres: 'm',
  in: 'in', inch: 'in', inches: 'in', '"': 'in',
  ft: 'ft', foot: 'ft', feet: 'ft', "'": 'ft',
};

/** Canonical short code for a unit spelling, or null when it isn't one. */
export function parseProjectUnit(value: unknown): LengthUnit | null {
  if (typeof value !== 'string') {
    return null;
  }
  return UNIT_ALIASES[value.trim().toLowerCase()] ?? null;
}

export type ProjectConfig = {
  /** The pinned engine version, or null when the project doesn't pin one. */
  engine: string | null;
  /** Which file the pin came from; null when there is no pin. */
  source: EnginePinSource | null;
  /** Absolute path of the file the pin came from; null when there is no pin. */
  filePath: string | null;
  /**
   * The project's document unit, or null when the project doesn't set one —
   * which every reader must treat as `mm`, the unit files have always had.
   */
  unit: LengthUnit | null;
  /**
   * The project's own materials (`materials` map), or null when it declares
   * none. A map with any invalid entry is dropped as a whole and reported
   * in `error`, so a typo never resolves half a table.
   */
  materials: ProjectMaterials | null;
  /**
   * The package this workspace is (`package` block), or null when it is a
   * plain project. Read from `fluidcad.json` only — a `package.json`'s own
   * name and version belong to npm. A block with any invalid field is
   * dropped as a whole and reported, like `materials`.
   */
  package: PackageInfo | null;
  /**
   * The project's package pins (`dependencies` map), or null when it pins
   * none. `fluidcad.json` only, and dropped as a whole on any invalid
   * entry, for the same reasons as `package`.
   */
  dependencies: PackageDependencies | null;
  /**
   * Why a config file that exists was not usable (unparseable JSON, an
   * `engine` that isn't a string, a `unit` that isn't one of ours, a
   * `materials` entry that isn't a material, a `package` or `dependencies`
   * entry that breaks its rules). A workspace with no config at all leaves
   * this undefined — that is the normal case, not a problem.
   */
  error?: string;
  /**
   * The same sentences as `error`, keyed by what each one is about, so a
   * reader can tell which key failed without searching the text (a user's
   * material id or export path may well spell another key's name). Absent
   * exactly when `error` is.
   */
  problems?: ProjectConfigProblems;
};

/**
 * What a `ProjectConfig` problem is about. `file` is a `fluidcad.json` that
 * isn't JSON at all; each other key is that key failing on its own.
 */
export type ProjectConfigProblemKey = 'file' | 'engine' | 'unit' | 'materials' | 'package' | 'dependencies';

export type ProjectConfigProblems = Partial<Record<ProjectConfigProblemKey, string>>;

const EMPTY: ProjectConfig = {
  engine: null, source: null, filePath: null, unit: null, materials: null, package: null, dependencies: null,
};

export const PROJECT_CONFIG_FILENAME = 'fluidcad.json';

function readJson(filePath: string): { value: unknown } | { error: string } | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null; // Absent (or unreadable) — indistinguishable, and both mean "no pin".
  }
  try {
    return { value: JSON.parse(raw) };
  } catch (err: any) {
    return { error: `${path.basename(filePath)} is not valid JSON: ${err?.message ?? err}` };
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Read a `unit` field: absent is fine (null, no error), anything we can't
 * canonicalise is reported so a typo doesn't silently fall back to mm.
 */
function readUnitField(
  record: Record<string, unknown> | null,
  fileName: string,
): { unit: LengthUnit | null } | { error: string } {
  const raw = record?.unit;
  if (raw === undefined || raw === null) {
    return { unit: null };
  }
  const unit = parseProjectUnit(raw);
  if (unit === null) {
    return {
      error: `${fileName} has a "unit" that is not a length unit (${JSON.stringify(raw)}); use one of: ${LENGTH_UNITS.join(', ')}.`,
    };
  }
  return { unit };
}

/**
 * Validate a `materials` map wherever it comes from (a config file, the
 * preferences file's global list, a pick copied into the project): a map keyed by non-empty ids whose
 * values carry a non-empty string `name`, a finite positive `density` and,
 * when present, a `densityUnit` from `DENSITY_UNITS`. One bad entry rejects
 * the map; `problem` is a clause the caller prefixes with its subject.
 */
export function parseProjectMaterials(raw: unknown): { materials: ProjectMaterials } | { problem: string } {
  const map = asRecord(raw);
  if (map === null) {
    return { problem: 'is not a map of id → { name, density, densityUnit? }' };
  }
  const materials: ProjectMaterials = {};
  for (const [id, value] of Object.entries(map)) {
    const entry = asRecord(value);
    if (id.trim() === '') {
      return { problem: 'has an entry with an empty id' };
    }
    if (entry === null) {
      return { problem: `has an entry ${JSON.stringify(id)} that is not an object` };
    }
    if (typeof entry.name !== 'string' || entry.name.trim() === '') {
      return { problem: `has an entry ${JSON.stringify(id)} without a "name" string` };
    }
    if (typeof entry.density !== 'number' || !Number.isFinite(entry.density) || entry.density <= 0) {
      return { problem: `has an entry ${JSON.stringify(id)} whose "density" is not a positive number` };
    }
    if (entry.densityUnit !== undefined && !(DENSITY_UNITS as readonly unknown[]).includes(entry.densityUnit)) {
      return {
        problem: `has an entry ${JSON.stringify(id)} with a "densityUnit" that is not one of: ${DENSITY_UNITS.join(', ')}`,
      };
    }
    materials[id] = {
      name: entry.name,
      density: entry.density,
      ...(entry.densityUnit !== undefined ? { densityUnit: entry.densityUnit as DensityUnit } : {}),
    };
  }
  return { materials };
}

/**
 * Read a `materials` field: absent is fine (null, no error); otherwise
 * `parseProjectMaterials` decides, and a bad map is reported rather than
 * silently defaulted, mirroring how a bad `unit` is handled.
 */
function readMaterialsField(
  record: Record<string, unknown> | null,
  fileName: string,
): { materials: ProjectMaterials | null } | { error: string } {
  const raw = record?.materials;
  if (raw === undefined || raw === null) {
    return { materials: null };
  }
  const parsed = parseProjectMaterials(raw);
  if ('problem' in parsed) {
    return { error: `${fileName} has a "materials" that ${parsed.problem}.` };
  }
  return { materials: parsed.materials };
}

/**
 * Read a `package` block: absent is fine (null, no error); otherwise
 * `PackageFields.parseInfo` decides, and a bad block is reported on its
 * own — it never costs the engine pin, the unit or the materials.
 */
function readPackageField(
  record: Record<string, unknown> | null,
  workspacePath: string,
): { package: PackageInfo | null } | { error: string } {
  const raw = record?.package;
  if (raw === undefined || raw === null) {
    return { package: null };
  }
  const parsed = PackageFields.parseInfo(raw, workspacePath);
  if ('problem' in parsed) {
    return { error: `${PROJECT_CONFIG_FILENAME} has a "package" ${parsed.problem}.` };
  }
  return { package: parsed.info };
}

/** Read a `dependencies` map — the same rules as `readPackageField`. */
function readDependenciesField(
  record: Record<string, unknown> | null,
): { dependencies: PackageDependencies | null } | { error: string } {
  const raw = record?.dependencies;
  if (raw === undefined || raw === null) {
    return { dependencies: null };
  }
  const parsed = PackageFields.parseDependencies(raw);
  if ('problem' in parsed) {
    return { error: `${PROJECT_CONFIG_FILENAME} has "dependencies" ${parsed.problem}.` };
  }
  return { dependencies: parsed.dependencies };
}

/** `error` and `problems` for a config, or neither when nothing failed. */
function withProblems(problems: ProjectConfigProblems): Pick<ProjectConfig, 'error' | 'problems'> {
  const sentences = Object.values(problems).filter((e): e is string => e !== undefined);
  if (sentences.length === 0) {
    return {};
  }
  return { error: sentences.join(' '), problems };
}

/**
 * Read the workspace's project config. `fluidcad.json` wins over
 * `package.json`'s `{ "fluidcad": { "engine": "…", "unit": "…", "materials": {…} } }`
 * key by key; a workspace with neither reads back as an empty config, which
 * every caller must treat as "behave exactly as before the config existed".
 * `package` and `dependencies` are read from `fluidcad.json` alone.
 */
export function readProjectConfig(workspacePath: string): ProjectConfig {
  if (!workspacePath) {
    return EMPTY;
  }

  let engine: Pick<ProjectConfig, 'engine' | 'source' | 'filePath'> | null = null;
  let unit: LengthUnit | null = null;
  let materials: ProjectMaterials | null = null;
  let packageInfo: PackageInfo | null = null;
  let dependencies: PackageDependencies | null = null;
  // Insertion order is the order the sentences join into `error`.
  const problems: ProjectConfigProblems = {};

  const configPath = path.join(workspacePath, PROJECT_CONFIG_FILENAME);
  const config = readJson(configPath);
  if (config !== null) {
    if ('error' in config) {
      return { ...EMPTY, ...withProblems({ file: config.error }) };
    }
    const record = asRecord(config.value);
    const pinned = record?.engine;
    if (typeof pinned === 'string' && pinned.trim() !== '') {
      engine = { engine: pinned.trim(), source: 'fluidcad.json', filePath: configPath };
    } else if (pinned !== undefined) {
      problems.engine = `${PROJECT_CONFIG_FILENAME} has an "engine" that is not a version string.`;
    }

    // The package keys fail on their own, whatever the rest of the file
    // holds — even a bad `engine`, which (below) still costs the unit and
    // the materials, as it always has.
    const packageField = readPackageField(record, workspacePath);
    if ('error' in packageField) {
      problems.package = packageField.error;
    } else {
      packageInfo = packageField.package;
    }
    const dependenciesField = readDependenciesField(record);
    if ('error' in dependenciesField) {
      problems.dependencies = dependenciesField.error;
    } else {
      dependencies = dependenciesField.dependencies;
    }

    if (problems.engine !== undefined) {
      return { ...EMPTY, package: packageInfo, dependencies, ...withProblems(problems) };
    }

    // A `fluidcad.json` with no `engine` key is legal — a project may only
    // set its unit — so each missing key falls through to package.json
    // rather than reporting an error.
    const unitField = readUnitField(record, PROJECT_CONFIG_FILENAME);
    if ('error' in unitField) {
      problems.unit = unitField.error;
    } else {
      unit = unitField.unit;
    }
    const materialsField = readMaterialsField(record, PROJECT_CONFIG_FILENAME);
    if ('error' in materialsField) {
      problems.materials = materialsField.error;
    } else {
      materials = materialsField.materials;
    }
  }

  const pkgPath = path.join(workspacePath, 'package.json');
  const pkg = readJson(pkgPath);
  if (pkg && 'value' in pkg) {
    const record = asRecord(asRecord(pkg.value)?.fluidcad);
    const pinned = record?.engine;
    if (engine === null && typeof pinned === 'string' && pinned.trim() !== '') {
      engine = { engine: pinned.trim(), source: 'package.json', filePath: pkgPath };
    }
    if (unit === null && problems.unit === undefined) {
      const unitField = readUnitField(record, 'package.json');
      if ('error' in unitField) {
        problems.unit = unitField.error;
      } else {
        unit = unitField.unit;
      }
    }
    if (materials === null && problems.materials === undefined) {
      const materialsField = readMaterialsField(record, 'package.json');
      if ('error' in materialsField) {
        problems.materials = materialsField.error;
      } else {
        materials = materialsField.materials;
      }
    }
  }
  // An unparseable workspace `package.json` is not ours to complain about.

  return {
    ...(engine ?? EMPTY),
    unit,
    materials,
    package: packageInfo,
    dependencies,
    ...withProblems(problems),
  };
}

/**
 * True when `config.error` is about the `unit` key. The engine pin and the
 * unit are read from the same file but fail independently: a bad unit must
 * not read as "ignoring the engine pin", and vice versa.
 */
export function isProjectUnitError(config: ProjectConfig): boolean {
  return config.problems?.unit !== undefined;
}

/** True when `config.error` is about the `materials` key — same independence rule as the unit. */
export function isProjectMaterialsError(config: ProjectConfig): boolean {
  return config.problems?.materials !== undefined;
}

/**
 * True when `config.error` is about the `package` block — same independence
 * rule: a bad block makes the workspace read as no package, and nothing else.
 */
export function isProjectPackageError(config: ProjectConfig): boolean {
  return config.problems?.package !== undefined;
}

/** True when `config.error` is about the `dependencies` map — same independence rule. */
export function isProjectDependenciesError(config: ProjectConfig): boolean {
  return config.problems?.dependencies !== undefined;
}

/**
 * True when the workspace's `fluidcad.json` exists but isn't JSON at all.
 * Every writer replaces such a file with just its own patch, so a caller
 * about to write a key the user typed (a package block) should refuse
 * instead.
 */
export function isProjectConfigUnreadable(config: ProjectConfig): boolean {
  return config.problems?.file !== undefined;
}

/**
 * True when `config.error` concerns the engine pin itself (unparseable
 * file, a non-string `engine`) rather than the unit, materials or package
 * keys, which are read from the same file but fail on their own.
 */
function isEnginePinError(config: ProjectConfig): boolean {
  return config.problems?.file !== undefined || config.problems?.engine !== undefined;
}

/** The workspace's `fluidcad.json` as a plain object, or null when it is absent, unparseable or not an object. */
function readConfigRecord(workspacePath: string): Record<string, unknown> | null {
  const existing = readJson(path.join(workspacePath, PROJECT_CONFIG_FILENAME));
  return existing && 'value' in existing ? asRecord(existing.value) : null;
}

/**
 * Shallow-merge `patch` into the workspace's `fluidcad.json`, preserving any
 * other keys already in the file. A key patched to `undefined` is removed.
 * Writing always targets `fluidcad.json` even when the current values came
 * from `package.json` — we don't rewrite a file whose other contents belong
 * to npm.
 */
function mergeIntoProjectConfig(workspacePath: string, patch: Record<string, unknown>): string {
  const configPath = path.join(workspacePath, PROJECT_CONFIG_FILENAME);
  const next = { ...(readConfigRecord(workspacePath) ?? {}), ...patch };
  // JSON.stringify drops the undefined values, which is the removal.
  fs.writeFileSync(configPath, JSON.stringify(next, null, 2) + '\n');
  return configPath;
}

/** Write `engine` into the workspace's `fluidcad.json`, keeping every other key. */
export function writeEnginePin(workspacePath: string, version: string): string {
  return mergeIntoProjectConfig(workspacePath, { engine: version });
}

/** Write `unit` into the workspace's `fluidcad.json`, keeping every other key. */
export function writeProjectUnit(workspacePath: string, unit: LengthUnit): string {
  return mergeIntoProjectConfig(workspacePath, { unit });
}

/** Write the whole `materials` map into the workspace's `fluidcad.json`, keeping every other key. */
export function writeProjectMaterials(workspacePath: string, materials: ProjectMaterials): string {
  return mergeIntoProjectConfig(workspacePath, { materials });
}

/**
 * Write the `package` block into the workspace's `fluidcad.json`, keeping
 * every other key of the file and every key of the old block this engine
 * does not read. Throws on a block that would read back invalid, so the
 * writer never leaves a workspace that is suddenly not a package.
 */
export function writePackageInfo(workspacePath: string, info: PackageInfo): string {
  const parsed = PackageFields.parseInfo(info, workspacePath);
  if ('problem' in parsed) {
    throw new Error(`Refusing to write a "package" ${parsed.problem}.`);
  }
  const block = PackageFields.mergeInfo(parsed.info, readConfigRecord(workspacePath)?.package);
  return mergeIntoProjectConfig(workspacePath, { package: block });
}

/**
 * Pin `name` at `pin` in the workspace's `dependencies`, replacing any pin
 * it had and keeping every other entry (sorted by name, for stable diffs)
 * and every other key of the file. Throws on a pin that would read back
 * invalid.
 */
export function writeDependency(workspacePath: string, name: string, pin: PackagePin): string {
  const parsed = PackageFields.parsePin(name, pin);
  if ('problem' in parsed) {
    throw new Error(`Refusing to write "dependencies" ${parsed.problem}.`);
  }
  const entries = { ...dependencyEntries(workspacePath), [name]: parsed.pin };
  return mergeIntoProjectConfig(workspacePath, { dependencies: sortedByKey(entries) });
}

/**
 * Drop `name` from the workspace's `dependencies`, keeping every other entry
 * and key; the last pin removed takes the `dependencies` key with it. A
 * name that isn't pinned leaves the file untouched.
 */
export function removeDependency(workspacePath: string, name: string): string {
  const configPath = path.join(workspacePath, PROJECT_CONFIG_FILENAME);
  const entries = dependencyEntries(workspacePath);
  if (!Object.prototype.hasOwnProperty.call(entries, name)) {
    return configPath;
  }
  delete entries[name];
  const remaining = Object.keys(entries).length > 0 ? sortedByKey(entries) : undefined;
  return mergeIntoProjectConfig(workspacePath, { dependencies: remaining });
}

/**
 * The raw `dependencies` entries as the file holds them, invalid ones
 * included: a writer changes the one pin it was asked to and never
 * silently deletes the others.
 */
function dependencyEntries(workspacePath: string): Record<string, unknown> {
  return { ...(asRecord(readConfigRecord(workspacePath)?.dependencies) ?? {}) };
}

function sortedByKey(entries: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(entries).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/**
 * The one-line warning for a project whose pin doesn't match the engine that
 * is actually running, or null when they agree (or there is no pin). Kept here
 * so every entry point words it the same way.
 */
export function describeEnginePinMismatch(
  config: ProjectConfig,
  runningVersion: string,
): string | null {
  if (isEnginePinError(config)) {
    return `FluidCAD: ${config.problems.file ?? config.problems.engine} Ignoring the engine pin.`;
  }
  if (!config.engine || config.engine === runningVersion) {
    return null;
  }
  return (
    `FluidCAD: this project pins engine ${config.engine} ` +
    `(${config.source}), but ${runningVersion} is running. ` +
    `Geometry may differ from what the project was authored against.`
  );
}

/**
 * The one-line warning for a project whose configured unit could not be
 * read, or null when the unit is fine (or unset). Same home as the pin
 * warning, for the same reason: every entry point words it the same way.
 */
export function describeProjectUnitProblem(config: ProjectConfig): string | null {
  if (!isProjectUnitError(config)) {
    return null;
  }
  return `FluidCAD: ${config.problems.unit} Using mm.`;
}

/**
 * The one-line warning for a project whose `materials` map could not be
 * read (the map is ignored, built-ins alone remain), or null when it is
 * fine or unset.
 */
export function describeProjectMaterialsProblem(config: ProjectConfig): string | null {
  if (!isProjectMaterialsError(config)) {
    return null;
  }
  return `FluidCAD: ${config.problems.materials} Ignoring the project materials.`;
}

/**
 * The one-line warning for a workspace whose `package` block could not be
 * read (the workspace reads as a plain project until it is fixed), or null
 * when it is fine or unset.
 */
export function describeProjectPackageProblem(config: ProjectConfig): string | null {
  if (!isProjectPackageError(config)) {
    return null;
  }
  return `FluidCAD: ${config.problems.package} Treating this workspace as a plain project, not a package.`;
}

/**
 * The one-line warning for a project whose `dependencies` map could not be
 * read (no package pin is used until it is fixed), or null when it is fine
 * or unset.
 */
export function describeProjectDependenciesProblem(config: ProjectConfig): string | null {
  if (!isProjectDependenciesError(config)) {
    return null;
  }
  return `FluidCAD: ${config.problems.dependencies} Ignoring the project's package pins.`;
}

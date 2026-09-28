import fs from 'fs';
import path from 'path';

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
 * Deliberately dependency-free (node builtins only): this module is imported
 * by the server (TS) and, as compiled JS out of `server/dist`, by the plain-JS
 * CLI in `bin/`.
 */

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
   * Why a config file that exists was not usable (unparseable JSON, an
   * `engine` that isn't a string, a `unit` that isn't one of ours, a
   * `materials` entry that isn't a material). A workspace with no config
   * at all leaves this undefined — that is the normal case, not a problem.
   */
  error?: string;
};

const EMPTY: ProjectConfig = { engine: null, source: null, filePath: null, unit: null, materials: null };

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
 * Manage materials… dialog's write): a map keyed by non-empty ids whose
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
 * Read the workspace's project config. `fluidcad.json` wins over
 * `package.json`'s `{ "fluidcad": { "engine": "…", "unit": "…", "materials": {…} } }`
 * key by key; a workspace with neither reads back as an empty config, which
 * every caller must treat as "behave exactly as before the config existed".
 */
export function readProjectConfig(workspacePath: string): ProjectConfig {
  if (!workspacePath) {
    return EMPTY;
  }

  let engine: Pick<ProjectConfig, 'engine' | 'source' | 'filePath'> | null = null;
  let unit: LengthUnit | null = null;
  let unitError: string | undefined;
  let materials: ProjectMaterials | null = null;
  let materialsError: string | undefined;

  const configPath = path.join(workspacePath, PROJECT_CONFIG_FILENAME);
  const config = readJson(configPath);
  if (config !== null) {
    if ('error' in config) {
      return { ...EMPTY, error: config.error };
    }
    const record = asRecord(config.value);
    const pinned = record?.engine;
    if (typeof pinned === 'string' && pinned.trim() !== '') {
      engine = { engine: pinned.trim(), source: 'fluidcad.json', filePath: configPath };
    } else if (pinned !== undefined) {
      return {
        ...EMPTY,
        error: `${PROJECT_CONFIG_FILENAME} has an "engine" that is not a version string.`,
      };
    }
    // A `fluidcad.json` with no `engine` key is legal — a project may only
    // set its unit — so each missing key falls through to package.json
    // rather than reporting an error.
    const unitField = readUnitField(record, PROJECT_CONFIG_FILENAME);
    if ('error' in unitField) {
      unitError = unitField.error;
    } else {
      unit = unitField.unit;
    }
    const materialsField = readMaterialsField(record, PROJECT_CONFIG_FILENAME);
    if ('error' in materialsField) {
      materialsError = materialsField.error;
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
    if (unit === null && unitError === undefined) {
      const unitField = readUnitField(record, 'package.json');
      if ('error' in unitField) {
        unitError = unitField.error;
      } else {
        unit = unitField.unit;
      }
    }
    if (materials === null && materialsError === undefined) {
      const materialsField = readMaterialsField(record, 'package.json');
      if ('error' in materialsField) {
        materialsError = materialsField.error;
      } else {
        materials = materialsField.materials;
      }
    }
  }
  // An unparseable workspace `package.json` is not ours to complain about.

  const errors = [unitError, materialsError].filter((e): e is string => e !== undefined);
  return {
    ...(engine ?? EMPTY),
    unit,
    materials,
    ...(errors.length > 0 ? { error: errors.join(' ') } : {}),
  };
}

/**
 * True when `config.error` is about the `unit` key. The engine pin and the
 * unit are read from the same file but fail independently: a bad unit must
 * not read as "ignoring the engine pin", and vice versa.
 */
export function isProjectUnitError(config: ProjectConfig): boolean {
  return typeof config.error === 'string' && config.error.includes('"unit"');
}

/** True when `config.error` is about the `materials` key — same independence rule as the unit. */
export function isProjectMaterialsError(config: ProjectConfig): boolean {
  return typeof config.error === 'string' && config.error.includes('"materials"');
}

/**
 * True when `config.error` concerns the engine pin itself (unparseable
 * file, a non-string `engine`) rather than the unit or materials keys,
 * which are read from the same file but fail on their own.
 */
function isEnginePinError(config: ProjectConfig): boolean {
  return typeof config.error === 'string' && !isProjectUnitError(config) && !isProjectMaterialsError(config);
}

/**
 * Shallow-merge `patch` into the workspace's `fluidcad.json`, preserving any
 * other keys already in the file. Writing always targets `fluidcad.json`
 * even when the current values came from `package.json` — we don't rewrite
 * a file whose other contents belong to npm.
 */
function mergeIntoProjectConfig(workspacePath: string, patch: Record<string, unknown>): string {
  const configPath = path.join(workspacePath, PROJECT_CONFIG_FILENAME);
  const existing = readJson(configPath);
  const base = existing && 'value' in existing ? asRecord(existing.value) : null;
  const next = { ...(base ?? {}), ...patch };
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
 * The one-line warning for a project whose pin doesn't match the engine that
 * is actually running, or null when they agree (or there is no pin). Kept here
 * so every entry point words it the same way.
 */
export function describeEnginePinMismatch(
  config: ProjectConfig,
  runningVersion: string,
): string | null {
  if (isEnginePinError(config)) {
    return `FluidCAD: ${config.error} Ignoring the engine pin.`;
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
  return `FluidCAD: ${config.error} Using mm.`;
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
  return `FluidCAD: ${config.error} Ignoring the project materials.`;
}

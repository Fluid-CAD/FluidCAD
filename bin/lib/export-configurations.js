import { basename, dirname, extname, resolve } from 'path';

/**
 * `fluidcad export … --configuration <name>` / `--all-configurations`: the
 * flag checks and the per-row output paths, kept free of I/O so they are
 * testable on their own (`bin/tests/export-configurations.test.ts`).
 */

export const DEFAULT_CONFIGURATION = 'Default';

/** `shapeIds: "all"` — every solid of the scene the server exports (a row's own render when it is not on screen). */
export const EVERY_SOLID = 'all';

/**
 * What a `fluidcad export step|stl` request selects when `--shapes` is not
 * given: an assembly file exports whole (`{ assembly: {} }`); any other file
 * every solid of the scene exported (`{ shapeIds: "all" }`), so each
 * configuration row writes its own bodies — one a row adds included, one it
 * drops left out. With `--shapes` (`requested` non-null) this is null: the
 * tokens resolve to ids of the scene on screen, which the server maps onto
 * each row and refuses where a row does not build them.
 */
export function defaultSelector({ assembly, requested }) {
  if (requested !== null) {
    return null;
  }
  return assembly ? { assembly: {} } : { shapeIds: EVERY_SOLID };
}

/**
 * `--all-configurations`: every target's file, fetched through
 * `exportRow(configuration)` (resolving `{ ok, buffer }` or a failed
 * response) before any is written — a row that fails stops the run, naming
 * it, and writes nothing: a partial set would pass for a complete one.
 * `describeFailure(response)` turns a failed response into its message.
 */
export async function collectConfigurationExports(targets, exportRow, describeFailure) {
  const files = [];
  for (const target of targets) {
    const result = await exportRow(target.configuration);
    if (!result.ok) {
      throw new Error(`Export of ${target.configuration} failed, so nothing was written: ${describeFailure(result)}`);
    }
    files.push({ ...target, buffer: result.buffer });
  }
  return files;
}

/**
 * The configuration flags as a request plan: `null` (export the row on
 * screen), `{ kind: 'one', name }` or `{ kind: 'all' }`. `allowAll` is false
 * for png, which captures a single image.
 */
export function parseConfigurationOptions(opts, { allowAll = true } = {}) {
  const name = opts.configuration;
  const all = opts.allConfigurations === true;
  if (name !== undefined && (typeof name !== 'string' || name.trim() === '')) {
    throw new Error('--configuration needs a configuration name (a configurations() row, or Default).');
  }
  if (all && !allowAll) {
    throw new Error('--all-configurations exports STEP and STL only; pass --configuration <name> for a PNG.');
  }
  if (all && name !== undefined) {
    throw new Error('Pass either --configuration <name> or --all-configurations, not both.');
  }
  if (all && opts.listShapes) {
    throw new Error('--all-configurations exports files; drop it to --list-shapes.');
  }
  if (all) {
    return { kind: 'all' };
  }
  return name === undefined ? null : { kind: 'one', name: name.trim() };
}

/**
 * A row name as a file-name segment: anything outside letters, digits, `.`,
 * `_` and `-` becomes `-`, runs collapse, and leading/trailing separators go.
 */
export function sanitizeConfigurationName(name) {
  const cleaned = String(name)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return cleaned || 'configuration';
}

/**
 * Every file `--all-configurations` writes: Default as `<model><ext>`, then
 * each row as `<model>-<Row><ext>` in declaration order. With `-o`, its path
 * (extension dropped) is the `<model>` part. Two rows that sanitise alike
 * get `-2`, `-3`, … so no file overwrites another.
 */
export function allConfigurationTargets(names, { outOption, modelName, extension, cwd = process.cwd() }) {
  const base = outOption
    ? stripExtension(resolve(outOption), extension)
    : resolve(cwd, modelName);
  const targets = [{ configuration: DEFAULT_CONFIGURATION, outPath: `${base}${extension}` }];
  const taken = new Set([`${base}${extension}`.toLowerCase()]);
  for (const name of names) {
    if (name === DEFAULT_CONFIGURATION) {
      continue;
    }
    const segment = sanitizeConfigurationName(name);
    let outPath = `${base}-${segment}${extension}`;
    for (let n = 2; taken.has(outPath.toLowerCase()); n++) {
      outPath = `${base}-${segment}-${n}${extension}`;
    }
    taken.add(outPath.toLowerCase());
    targets.push({ configuration: name, outPath });
  }
  return targets;
}

function stripExtension(path, extension) {
  const ext = extname(path);
  if (ext && ext.toLowerCase() === extension.toLowerCase()) {
    return resolve(dirname(path), basename(path, ext));
  }
  return path;
}

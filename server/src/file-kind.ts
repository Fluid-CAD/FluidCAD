export type FluidScriptKind = 'part' | 'assembly';

const SUFFIXES: Array<{ suffix: string; kind: FluidScriptKind }> = [
  { suffix: '.assembly.js', kind: 'assembly' },
  { suffix: '.part.js', kind: 'part' },
  { suffix: '.fluid.js', kind: 'part' },
];

export function detectKind(filePath: string): FluidScriptKind | null {
  for (const { suffix, kind } of SUFFIXES) {
    if (filePath.endsWith(suffix)) {
      return kind;
    }
  }
  return null;
}

export function isFluidScriptFile(filePath: string): boolean {
  return detectKind(filePath) !== null;
}

/** The suffix of a global-parameters module (`docs/global-parameters-plan.md` §2.2). */
export const PARAMS_FILE_SUFFIX = '.params.js';

/**
 * A `*.params.js` file: a module of exported `param()` declarations every
 * model in the workspace may import. It is not a model — `detectKind` stays
 * null for it, it is never rendered as the scene — so a path is one or the
 * other, never both.
 */
export function isParamsFile(filePath: string): boolean {
  return filePath.endsWith(PARAMS_FILE_SUFFIX);
}

/** What a new params file starts as: the one import its declarations need. */
export const PARAMS_FILE_TEMPLATE = `import { param } from 'fluidcad/core';\n\n`;

/** The suffix of a custom feature module (`docs/custom-features`): the `FeatureModules` walker's. */
export const FEATURE_FILE_SUFFIX = '.feature.js';

/**
 * A `*.feature.js` file: a module whose named exports are feature builders
 * the toolbar's Custom menu offers. Not a model — `detectKind` stays null
 * for it — so a path is one or the other, never both.
 */
export function isFeatureFile(filePath: string): boolean {
  return filePath.endsWith(FEATURE_FILE_SUFFIX);
}

/**
 * Words that can't be the exported binding of a new file: JS reserved
 * words, plus the wrapper the template imports (`part` / `assembly`).
 */
const RESERVED_EXPORT_NAMES = new Set([
  'part', 'assembly',
  'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger',
  'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'false',
  'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'let',
  'new', 'null', 'return', 'static', 'super', 'switch', 'this', 'throw',
  'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield',
]);

/**
 * Words a new feature module's export can't be, on top of the reserved
 * words: its class is the export capitalised, so `feature` would shadow the
 * `Feature` import, and `defineFeature` the other.
 */
const RESERVED_FEATURE_EXPORT_NAMES = new Set(['feature', 'defineFeature']);

/** `bracket.part.js` → `bracket`; the base name without its typed suffix. */
function baseNameOf(filePath: string, suffix: RegExp): string {
  return (filePath.split(/[\\/]/).pop() ?? '').replace(suffix, '');
}

/** `gantry-frame` → `gantryFrame`: the base name as an export binding (not checked for validity). */
function camelCase(base: string): string {
  return base
    .split(/[^A-Za-z0-9]+/)
    .filter(w => w.length > 0)
    .map((word, i) => (i === 0 ? word.charAt(0).toLowerCase() : word.charAt(0).toUpperCase()) + word.slice(1))
    .join('');
}

function isIdentifier(name: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name);
}

/** `base` as a single-quoted JS string literal's contents. */
function quoteContents(base: string): string {
  return base.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/**
 * Starter content for a file the editor creates empty. A new part file
 * begins as an exported `part()` definition and a new assembly file as an
 * exported `assembly()` one, so that everything the tools emit lands inside
 * the callback — a top-level insert() would run at module scope instead of
 * in the assembly's frame, and param() refuses a call outside a part body.
 * The export is the file's base name camel-cased; the display name keeps
 * the base name verbatim. A params file starts with the `param` import and
 * nothing else — the Parameters panel adds its declarations. A feature file
 * starts as a working feature ({@link FEATURE_FILE_TEMPLATE}). Other
 * non-fluid files start blank.
 */
export function newFileContent(filePath: string): string {
  if (isParamsFile(filePath)) {
    return PARAMS_FILE_TEMPLATE;
  }
  if (isFeatureFile(filePath)) {
    return newFeatureFileContent(filePath);
  }
  const kind = detectKind(filePath);
  if (kind === null) {
    return '';
  }
  const base = baseNameOf(filePath, /\.(assembly|part|fluid)\.js$/);
  let exportName = camelCase(base);
  if (!isIdentifier(exportName) || RESERVED_EXPORT_NAMES.has(exportName)) {
    exportName = kind === 'assembly' ? 'mainAssembly' : 'mainPart';
  }
  return [
    `import { ${kind} } from 'fluidcad/core';`,
    '',
    `export const ${exportName} = ${kind}('${quoteContents(base || exportName)}', () => {`,
    '});',
    '',
  ].join('\n');
}

/**
 * What a new feature module starts as: a feature that works as created,
 * for its author to reshape — a boss standing on a picked planar face,
 * with the class, the id, `buildTool()` and the `defineFeature()` export
 * the Custom menu needs, each annotated. Created empty, the module would
 * only show in that menu as a greyed "exports no feature" entry. The id and
 * the label keep the base name; the class and the builder are it camel-cased
 * (`my-boss.feature.js` → `MyBoss` / `myBoss`), falling back to
 * `MyFeature` / `myFeature` for a name that is no identifier or would
 * shadow an import.
 */
export function newFeatureFileContent(filePath: string): string {
  const base = baseNameOf(filePath, /\.feature\.js$/);
  let exportName = camelCase(base);
  if (!isIdentifier(exportName) || RESERVED_EXPORT_NAMES.has(exportName) || RESERVED_FEATURE_EXPORT_NAMES.has(exportName)) {
    exportName = 'myFeature';
  }
  const className = exportName.charAt(0).toUpperCase() + exportName.slice(1);
  const id = quoteContents(base || exportName);
  // The menu's label: the base name as words (`my-boss` → `My boss`).
  const words = base.split(/[^A-Za-z0-9]+/).filter(w => w.length > 0).join(' ');
  const label = quoteContents(words ? words.charAt(0).toUpperCase() + words.slice(1) : className);
  return [
    `import { Feature, defineFeature } from 'fluidcad/sdk';`,
    `import { Primitives, ShapeOps } from 'fluidcad/sdk/kernel';`,
    `import { Matrix4 } from 'fluidcad/math';`,
    ``,
    `// The values the feature takes: one picked face and two typed-in lengths.`,
    `// The dialog shows one row per value, in this order.`,
    `export class ${className} extends Feature.with({`,
    `  face: { picker: 'face', label: 'On face', surface: 'planar' },`,
    `  diameter: { type: 'length', default: 6, min: 0 },`,
    `  height: { type: 'length', default: 10, min: 0 },`,
    `}) {`,
    `  // The feature's type: it names the feature in every timeline.`,
    `  static id = '${id}';`,
    ``,
    `  // Returns the solids the feature adds; FluidCAD fuses them with the part.`,
    `  buildTool() {`,
    `    const { diameter, height } = this.values;`,
    `    const faces = this.facesOf(this.values.face);`,
    `    if (faces.length !== 1) {`,
    `      throw new Error(\`${id}: pick one planar face to stand on (got \${faces.length} faces)\`);`,
    `    }`,
    `    // Built standing on the XY plane, then placed on the picked face.`,
    `    const plane = faces[0].getPlane();`,
    `    const origin = plane.projectPoint(faces[0].center());`,
    `    const frame = Matrix4.fromBasis(plane.xDirection, plane.yDirection, plane.normal, origin);`,
    `    const boss = Primitives.makeCylinder(diameter / 2, height);`,
    `    const placed = ShapeOps.transform(boss, frame);`,
    `    boss.dispose();`,
    `    return [placed];`,
    `  }`,
    `}`,
    ``,
    `// Describes the feature for the toolbar's Custom menu and its dialog, and`,
    `// returns the builder a model calls: ${exportName}(face, { diameter, height }).`,
    `export const ${exportName} = defineFeature(${className}, {`,
    `  label: '${label}',`,
    `  group: 'create',`,
    `  operations: ['add', 'new'],`,
    `  call: ['face', { diameter: 'diameter', height: 'height' }],`,
    `});`,
    ``,
  ].join('\n');
}

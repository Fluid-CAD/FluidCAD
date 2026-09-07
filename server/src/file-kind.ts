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
 * Starter content for a file the editor creates empty. A new part file
 * begins as an exported `part()` definition and a new assembly file as an
 * exported `assembly()` one, so that everything the tools emit lands inside
 * the callback — a top-level insert() would run at module scope instead of
 * in the assembly's frame, and param() refuses a call outside a part body.
 * The export is the file's base name camel-cased; the display name keeps
 * the base name verbatim. Non-fluid files start blank.
 */
export function newFileContent(filePath: string): string {
  const kind = detectKind(filePath);
  if (kind === null) {
    return '';
  }
  const base = (filePath.split(/[\\/]/).pop() ?? '').replace(/\.(assembly|part|fluid)\.js$/, '');
  const words = base.split(/[^A-Za-z0-9]+/).filter(w => w.length > 0);
  let exportName = words
    .map((word, i) => (i === 0 ? word.charAt(0).toLowerCase() : word.charAt(0).toUpperCase()) + word.slice(1))
    .join('');
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(exportName) || RESERVED_EXPORT_NAMES.has(exportName)) {
    exportName = kind === 'assembly' ? 'mainAssembly' : 'mainPart';
  }
  const displayName = (base || exportName).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  return [
    `import { ${kind} } from 'fluidcad/core';`,
    '',
    `export const ${exportName} = ${kind}('${displayName}', () => {`,
    '});',
    '',
  ].join('\n');
}

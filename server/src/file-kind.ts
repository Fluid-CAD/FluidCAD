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
 * Words that can't be the exported binding of a new assembly file: JS
 * reserved words, plus `assembly` itself — the template imports it.
 */
const RESERVED_EXPORT_NAMES = new Set([
  'assembly',
  'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger',
  'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'false',
  'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'let',
  'new', 'null', 'return', 'static', 'super', 'switch', 'this', 'throw',
  'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield',
]);

/**
 * Starter content for a file the editor creates empty. A new assembly file
 * begins as an exported `assembly()` definition so inserted parts land
 * inside its callback — the insert transform appends inside a lone
 * assembly body, and a top-level insert() would run at module scope
 * instead of in the assembly's frame. Every other kind starts blank.
 */
export function newFileContent(filePath: string): string {
  if (detectKind(filePath) !== 'assembly') {
    return '';
  }
  const base = (filePath.split(/[\\/]/).pop() ?? '').replace(/\.assembly\.js$/, '');
  const words = base.split(/[^A-Za-z0-9]+/).filter(w => w.length > 0);
  let exportName = words
    .map((word, i) => (i === 0 ? word.charAt(0).toLowerCase() : word.charAt(0).toUpperCase()) + word.slice(1))
    .join('');
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(exportName) || RESERVED_EXPORT_NAMES.has(exportName)) {
    exportName = 'mainAssembly';
  }
  const displayName = (base || exportName).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  return [
    `import { assembly } from 'fluidcad/core';`,
    '',
    `export const ${exportName} = assembly('${displayName}', () => {`,
    '});',
    '',
  ].join('\n');
}

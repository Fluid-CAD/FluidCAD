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

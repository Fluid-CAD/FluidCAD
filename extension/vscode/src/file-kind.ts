const SUFFIXES = ['.part.js', '.assembly.js', '.fluid.js'];

export function isFluidScriptFile(name: string): boolean {
  return SUFFIXES.some(s => name.endsWith(s));
}

export function fluidScriptKind(name: string): 'part' | 'assembly' | null {
  if (name.endsWith('.assembly.js')) {
    return 'assembly';
  }
  if (name.endsWith('.part.js') || name.endsWith('.fluid.js')) {
    return 'part';
  }
  return null;
}

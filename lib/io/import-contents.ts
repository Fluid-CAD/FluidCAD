/**
 * What an imported asset holds, counted by what each body is to the user.
 * This module imports nothing so the ui can compile it in directly.
 */
export interface ImportContents {
  solids: number;
  surfaces: number;
  curves: number;
}

/** "3 solids, 2 surfaces, 1 curve" — the kinds present, in that order; null when there are none. */
export function describeImportContents(contents: ImportContents): string | null {
  const parts: string[] = [];
  const add = (n: number, word: string) => {
    if (n > 0) {
      parts.push(`${n} ${word}${n === 1 ? '' : 's'}`);
    }
  };
  add(contents.solids, 'solid');
  add(contents.surfaces, 'surface');
  add(contents.curves, 'curve');
  return parts.length > 0 ? parts.join(', ') : null;
}

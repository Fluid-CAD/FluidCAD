/**
 * What a file's name says about the model it holds. The suffix decides the
 * type — `.part.js` and `.fluid.js` are parts, `.assembly.js` an assembly —
 * and everything that reads it (tab labels and icons, the quick-open list,
 * the rename field) goes through here so they agree.
 */

export type ModelType = 'Part' | 'Assembly';
export type ModelName = { stem: string; type: ModelType };

/** Model suffixes, longest first so `.assembly.js` isn't mistaken for `.js`. */
const MODEL_SUFFIXES = ['.assembly.js', '.part.js', '.fluid.js'] as const;
type ModelSuffix = (typeof MODEL_SUFFIXES)[number];

/** The type a model suffix announces. */
const MODEL_TYPES: Readonly<Record<ModelSuffix, ModelType>> = {
  '.assembly.js': 'Assembly',
  '.part.js': 'Part',
  '.fluid.js': 'Part',
};

/**
 * The assembly workbench's teal, worn by assembly icons so an assembly reads
 * apart from a part (which wears the theme's primary blue) at a glance.
 */
export const ASSEMBLY_ACCENT = '#12A8A8';

/** `bracket.part.js` → `.part.js`; null for a file that is not a model. */
export function modelSuffixOf(basename: string): ModelSuffix | null {
  for (const suffix of MODEL_SUFFIXES) {
    if (basename.endsWith(suffix) && basename.length > suffix.length) {
      return suffix;
    }
  }
  return null;
}

/** `bracket.part.js` → `{ stem: 'bracket', type: 'Part' }`; null for anything else. */
export function splitModelName(basename: string): ModelName | null {
  const suffix = modelSuffixOf(basename);
  return suffix ? { stem: basename.slice(0, -suffix.length), type: MODEL_TYPES[suffix] } : null;
}

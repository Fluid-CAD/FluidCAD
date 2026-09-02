import { dirname, relative } from 'path';

/**
 * The import specifier that reaches `toFile` from inside `fromDir`: always
 * relative, always forward slashes, and always starting with `./` or `../`
 * so it can't be mistaken for a package name.
 */
export function relativeSpecifierFromDir(fromDir: string, toFile: string): string {
  let rel = relative(fromDir, toFile).replace(/\\/g, '/');
  if (!rel.startsWith('.')) {
    rel = './' + rel;
  }
  return rel;
}

/** {@link relativeSpecifierFromDir} for an import written inside `fromFile`. */
export function relativeSpecifier(fromFile: string, toFile: string): string {
  return relativeSpecifierFromDir(dirname(fromFile), toFile);
}

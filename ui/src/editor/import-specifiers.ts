import type { SpecifierReplacement } from './editor-api';

/**
 * Substitute module specifiers in text by their quoted literal. The
 * fallback for adopting a rename's importer rewrite into a buffer that
 * moved on while the request was in flight: the server's full text would
 * clobber what was typed meanwhile, so only the import paths are swapped.
 */
export function replaceSpecifiers(text: string, replacements: SpecifierReplacement[]): string {
  let out = text;
  for (const { from, to } of replacements) {
    for (const quote of ["'", '"']) {
      out = out.split(`${quote}${from}${quote}`).join(`${quote}${to}${quote}`);
    }
  }
  return out;
}

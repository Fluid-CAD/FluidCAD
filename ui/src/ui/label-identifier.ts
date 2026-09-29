/**
 * The identifier a label suggests — what a property's name, derived from
 * its label, is: camel-cased over the label's words (`Wall thickness` →
 * `wallThickness`). A label of pure punctuation leaves nothing to name;
 * one starting with a digit, or spelling a keyword, only needs a letter in
 * front of it (`2nd` → `p2nd`). Mirrors the server's
 * `identifierFromLabel`, which derives a parameter's variable the same
 * way, so what the dialog previews is what the file gets.
 */

const IDENTIFIER_RE = /^[a-zA-Z_$][\w$]*$/;

/** Reserved words a `const` declaration may not use as its name. */
const RESERVED_NAMES = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do',
  'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import',
  'in', 'instanceof', 'new', 'null', 'return', 'super', 'switch', 'this', 'throw', 'true', 'try',
  'typeof', 'var', 'void', 'while', 'with', 'let', 'static', 'yield', 'await', 'param', 'property',
]);

export function identifierFromLabel(label: string): string {
  const camel = label
    .split(/[^a-zA-Z0-9]+/)
    .filter((word) => word !== '')
    .map((word, i) => (i === 0 ? word.charAt(0).toLowerCase() : word.charAt(0).toUpperCase()) + word.slice(1))
    .join('');
  return camel !== '' && IDENTIFIER_RE.test(camel) && !RESERVED_NAMES.has(camel) ? camel : `p${camel}`;
}

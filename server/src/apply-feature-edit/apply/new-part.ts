// Appending a new part() body to the document.

import { chainRootCallee, getJavaScriptParser, walkTree } from '../../code-editor/index.ts';
import { appendTopLevelStatement } from '../insertion.ts';
import type { ApplyFeatureEditResult, ApplyFeatureEditSpec } from '../spec.ts';

/** Part names land in a single-quoted literal — no quotes or line breaks. */
function validPartName(name: string): boolean {
  return /^[^'"\\\r\n]{1,64}$/.test(name);
}

/**
 * The Part tool's statement: append `export const <ident> = part('<name>',
 * () => {})` at top level. A missing name allocates "Part N" past every
 * part() name already in the file, so repeated clicks keep minting fresh
 * parts. The binding is always exported — the part catalog indexes parts by
 * their `export const` name, so an exported part is insertable from an
 * assembly the moment it exists.
 */
export async function applyNewPart(
  code: string,
  newPart: NonNullable<ApplyFeatureEditSpec['newPart']>,
): Promise<ApplyFeatureEditResult> {
  if (newPart.name !== undefined && !validPartName(newPart.name)) {
    return { newCode: code, error: 'part names must be 1-64 characters without quotes or line breaks' };
  }
  const name = newPart.name ?? await allocateNewPartName(code);
  const exportName = pickPartExportName(code, name);
  return appendTopLevelStatement(
    code,
    indent => `export const ${exportName} = part('${name}', () => {\n\n${indent}})`,
    'part',
  );
}

/**
 * The export binding's identifier, derived from the part's display name
 * (`Part 1` → `part1`, `Box Body` → `boxBody`) — numeric-suffixed past any
 * word already appearing in the file, the same fresh-word rule the Insert
 * dialog's instance names follow.
 */
function pickPartExportName(code: string, displayName: string): string {
  const words = displayName.split(/[^A-Za-z0-9]+/).filter(w => w.length > 0);
  let base = words
    .map((w, i) => i === 0 ? w.charAt(0).toLowerCase() + w.slice(1) : w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(base)) {
    base = 'part';
  }
  if (!new RegExp(`\\b${base}\\b`).test(code)) {
    return base;
  }
  for (let n = 2; ; n++) {
    const candidate = `${base}${n}`;
    if (!new RegExp(`\\b${candidate}\\b`).test(code)) {
      return candidate;
    }
  }
}

/** The first "Part N" past every part() name already in the file. */
async function allocateNewPartName(code: string): Promise<string> {
  const parser = await getJavaScriptParser();
  const tree = parser.parse(code);
  const taken = new Set<string>();
  for (const node of walkTree(tree.rootNode)) {
    if (node.type !== 'call_expression' || chainRootCallee(node) !== 'part') {
      continue;
    }
    const first = node.childForFieldName('arguments')?.namedChildren
      .filter(a => a.type !== 'comment')[0];
    if (first && first.type === 'string') {
      taken.add(first.text.slice(1, -1));
    }
  }
  let n = 1;
  while (taken.has(`Part ${n}`)) {
    n++;
  }
  return `Part ${n}`;
}

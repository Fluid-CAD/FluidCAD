// Appending a new part() body to the document.

import { chainRootCallee, getJavaScriptParser, stringLiteralValue, walkTree } from '../../code-editor/index.ts';
import { PartRules } from '../../../../lib/dist/index.js';
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
 * parts; a given name the file already has takes the first free " N"
 * suffix (`Plate` → `Plate 2`), since part names are unique within a file.
 * The binding is always exported — every part is (lib `PartRules`), and the
 * part catalog indexes parts by their `export const` name, so the part is
 * insertable from an assembly the moment it exists.
 */
export async function applyNewPart(
  code: string,
  newPart: NonNullable<ApplyFeatureEditSpec['newPart']>,
): Promise<ApplyFeatureEditResult> {
  if (newPart.name !== undefined && !validPartName(newPart.name)) {
    return { newCode: code, error: 'part names must be 1-64 characters without quotes or line breaks' };
  }
  const taken = await partNamesIn(code);
  // Part names are unique within a file (lib PartRules): a name the file
  // already has gets the first free " N" suffix.
  const name = newPart.name === undefined ? allocateNewPartName(taken) : freePartName(newPart.name, taken);
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
  const base = PartRules.bindingFor(displayName);
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

/** Every string-literal name a `part()` call of the file takes. */
async function partNamesIn(code: string): Promise<Set<string>> {
  const parser = await getJavaScriptParser();
  const tree = parser.parse(code);
  const taken = new Set<string>();
  for (const node of walkTree(tree.rootNode)) {
    if (node.type !== 'call_expression' || chainRootCallee(node) !== 'part') {
      continue;
    }
    const first = node.childForFieldName('arguments')?.namedChildren
      .filter(a => a.type !== 'comment')[0];
    const name = first ? stringLiteralValue(first) : null;
    if (name !== null) {
      taken.add(name);
    }
  }
  return taken;
}

/** The first "Part N" past every part() name already in the file. */
function allocateNewPartName(taken: Set<string>): string {
  let n = 1;
  while (taken.has(`Part ${n}`)) {
    n++;
  }
  return `Part ${n}`;
}

/** `name` when the file has no part of that name, else `name 2`, `name 3`, … — the first free one. */
function freePartName(name: string, taken: Set<string>): string {
  if (!taken.has(name)) {
    return name;
  }
  let n = 2;
  while (taken.has(`${name} ${n}`)) {
    n++;
  }
  return `${name} ${n}`;
}

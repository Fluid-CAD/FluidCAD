// Binding names for sketch statements.
//
// A sketch region is keyed by the names of the statements on its boundary
// (`extrude(20).region('c1 l3')`); a statement without a binding only has an
// ordinal key (`circle#2`) that shifts when an earlier circle goes and
// changes outright when the statement is bound later. So the drawing tools
// bind every statement they write from the start, and the constraint rail
// hoists a hand-written unbound statement (`const l3 = line(…)`) the moment
// a constraint needs to reference it. Both draw from the one allocator here,
// so a new name never collides with a binding the file already holds.

import { SOLVED_ENTITY_NAME_HINTS } from './sketch-symbols.ts';
import type { TSNode } from './code-editor.ts';

const IDENTIFIER_NODE_TYPES = new Set<string>([
  'identifier', 'property_identifier', 'shorthand_property_identifier',
]);

/** Every identifier the file mentions — the names a new binding must avoid. */
export function collectIdentifiers(tree: { rootNode: TSNode }): Set<string> {
  const names = new Set<string>();
  const visit = (node: TSNode): void => {
    if (IDENTIFIER_NODE_TYPES.has(node.type)) {
      names.add(node.text);
    }
    for (const child of node.namedChildren) {
      visit(child);
    }
  };
  visit(tree.rootNode);
  return names;
}

/**
 * A fresh `<hint><n>` binding name for a statement of `kind` (`l3`, `c2`,
 * `el1`; `e` for a kind without a hint), added to `used`. The number is one
 * past the HIGHEST `<hint><n>` the scanned scope already holds, never the
 * first free one: after `l1` and `l3` the next line is `l4`. A name freed by
 * a deletion is therefore never handed to a new entity, so a stale
 * reference — a region key, a constraint in a file the user is still
 * editing — cannot silently attach to the wrong statement.
 */
export function allocateSolvedName(used: Set<string>, kind: string): string {
  const hint = SOLVED_ENTITY_NAME_HINTS[kind] ?? 'e';
  const numbered = new RegExp(`^${hint}(\\d+)$`);
  let highest = 0;
  for (const name of used) {
    const match = numbered.exec(name);
    if (match) {
      highest = Math.max(highest, Number(match[1]));
    }
  }
  const name = `${hint}${highest + 1}`;
  used.add(name);
  return name;
}

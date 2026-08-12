import {
  ensureSymbolImport,
  getJavaScriptParser,
  isBlankRow,
  joinLines,
  splitLines,
} from '../code-editor.ts';

/** What the chosen catalog export is, deciding the statement rendered for it. */
export type InsertPartKind = 'value' | 'factory' | 'assembly';

/**
 * The Insert dialog's edit payload — rides `ApplyFeatureEditSpec` as a
 * side-channel (like `paramEdit`/`segmentSwap`): every other spec field is
 * ignored and the transform below runs instead.
 */
export type InsertPartEditSpec = {
  /**
   * Module specifier for the part's file relative to the assembly file
   * (`'./side-plate.part.js'`), or null when the export comes from the
   * assembly file itself — its export declaration is already a top-level
   * binding there, so no import is added.
   */
  importFrom: string | null;
  exportName: string;
  /**
   * 'value' renders `insert(name)` and 'factory' renders `insert(name())`
   * — for parts and assembly() definitions alike, since insert() accepts
   * both. 'assembly' is the legacy sub-assembly spelling and now renders
   * `insert(name())` too (a factory returning an assembly() definition);
   * old-style factories that inserted directly into the enclosing scene
   * throw a clear migration error from insert() itself.
   */
  kind: InsertPartKind;
};

/**
 * Append the statement that brings a catalog export into the assembly file,
 * importing the export (and `insert` when the statement uses it) as needed:
 *
 *     import { sidePlate } from './side-plate.part.js';
 *     const sidePlate1 = insert(sidePlate());
 *
 *     import { gantryAssembly } from './gantry.assembly.js';
 *     const gantryAssembly1 = insert(gantryAssembly());
 *
 * The result is always bound to a fresh `const` so the follow-up flows
 * (translate chains, mates, sub-assembly connector paths) have a name to
 * reference.
 */
export async function applyInsertPartEdit(
  code: string,
  spec: InsertPartEditSpec,
): Promise<{ newCode: string; error?: string }> {
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(spec.exportName)) {
    return { newCode: code, error: `"${spec.exportName}" is not an importable identifier` };
  }
  let out = code;
  if (spec.importFrom) {
    out = await ensureSymbolImport(out, spec.exportName, spec.importFrom);
  }
  out = await ensureSymbolImport(out, 'insert');

  const varName = pickInstanceName(out, spec.exportName);
  const statement =
    `const ${varName} = insert(${spec.exportName}${spec.kind === 'value' ? '' : '()'});`;

  const parser = await getJavaScriptParser();
  const tree = parser.parse(out);
  const lines = splitLines(out);
  const children = tree.rootNode.namedChildren;
  const last = children[children.length - 1];
  const insertRow = last ? last.endPosition.row + 1 : lines.length;
  const separated = insertRow > 0 && !isBlankRow(lines, insertRow - 1);
  lines.splice(insertRow, 0, ...(separated ? ['', statement] : [statement]));
  return { newCode: joinLines(lines) };
}

/**
 * A fresh instance variable name derived from the export: factory prefixes
 * drop and the first letter lowers (`getExtrusion` → `extrusion1`), then the
 * smallest numeric suffix not already appearing as a word in the file wins —
 * matching the `p1`/`rail2` style assemblies are written in.
 */
function pickInstanceName(code: string, exportName: string): string {
  let base = exportName
    .replace(/\$/g, '')
    .replace(/^(get|create|make|build)(?=[A-Z0-9_])/, '');
  base = base.charAt(0).toLowerCase() + base.slice(1);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(base)) {
    base = 'instance';
  }
  for (let n = 1; ; n++) {
    const candidate = `${base}${n}`;
    if (!new RegExp(`\\b${candidate}\\b`).test(code)) {
      return candidate;
    }
  }
}

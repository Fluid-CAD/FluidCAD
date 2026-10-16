// Rendering the `const` declarations a spec's new variables land with.

import { isExpressionText, isPartLevelInitializer } from '../../code-editor/index.ts';
import type { ApplyFeatureEditSpec } from '../spec.ts';

/**
 * The `const <name> = <initializer>` lines `spec.newVariables` asks for —
 * validated to safe shapes, deduplicated, and filtered against names the
 * file already declares so a re-apply stays idempotent. Declarations whose
 * initializer calls `param()` or `property()` come back separately in
 * `paramDecls` — those land in the part body (a `param()` at its top, a
 * `property()` binding the part's bare property of that name), not before
 * the statement.
 */
export function renderNewVariableDecls(
  code: string,
  newVariables: ApplyFeatureEditSpec['newVariables'],
  semicolon: boolean,
): { decls: string[]; paramDecls: string[] } | { error: string } {
  if (!newVariables || newVariables.length === 0) {
    return { decls: [], paramDecls: [] };
  }
  const decls: string[] = [];
  const paramDecls: string[] = [];
  const seen = new Set<string>();
  for (const nv of newVariables) {
    if (!nv || typeof nv.name !== 'string' || !/^[a-zA-Z_$][\w$]*$/.test(nv.name)
      || !isExpressionText(nv.initializer)) {
      return { error: 'malformed new-variable declaration' };
    }
    if (seen.has(nv.name)) {
      continue;
    }
    seen.add(nv.name);
    const escaped = nv.name.replace(/\$/g, '\\$');
    if (new RegExp(`\\b(?:const|let|var)\\s+${escaped}\\b`).test(code)) {
      continue;
    }
    const target = isPartLevelInitializer(nv.initializer) ? paramDecls : decls;
    target.push(`const ${nv.name} = ${nv.initializer.trim()}${semicolon ? ';' : ''}`);
  }
  return { decls, paramDecls };
}

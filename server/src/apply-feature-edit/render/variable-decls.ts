// Rendering the `const` declarations a spec's new variables land with.

import { isExpressionText } from '../../code-editor.ts';
import type { ApplyFeatureEditSpec } from '../spec.ts';

/**
 * The `const <name> = <initializer>` lines `spec.newVariables` asks for —
 * validated to safe shapes, deduplicated, and filtered against names the
 * file already declares so a re-apply stays idempotent. Declarations whose
 * initializer calls `param()` come back separately in `paramDecls` — those
 * land at the top of the part body, not before the statement.
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
    const target = /\bparam\s*\(/.test(nv.initializer) ? paramDecls : decls;
    target.push(`const ${nv.name} = ${nv.initializer.trim()}${semicolon ? ';' : ''}`);
  }
  return { decls, paramDecls };
}

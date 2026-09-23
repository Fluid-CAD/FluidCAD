// Resolving the statements a spec's producers point at into bindable variables.

import {
  chainRootCallee,
  findEditableCallAt,
  walkTree,
  type TSNode,
  type TSTree,
} from '../../code-editor/index.ts';
import { enclosingFunctionScope, enclosingScope, enclosingStatement, sameNode } from '../ast/nodes.ts';
import { producerCallees, requiredChainRoots } from './callees.ts';
import type { ApplyFeatureEditSpec } from '../spec.ts';

export type ProducerBinding = {
  call: TSNode;
  statement: TSNode;
  scope: TSNode;
  varName: string | null;
  needsBinding: boolean;
  /** False for anchor-only entries — never named, never referenced by parts. */
  bind: boolean;
};

/**
 * Locate the statement holding the producer call and how to bind it:
 * - `const x = <call>` → reuse `x` (statement is the declaration, or the
 *   `export` statement wrapping it);
 * - `x = <call>` as a whole assignment statement → reuse `x`;
 * - `<call>;` as a bare expression statement → prepend `const <name> = `
 *   (same-row prepend, so later source lines don't shift);
 * - anything else (the call is nested inside another expression) → refuse
 *   rather than rewrite user code speculatively.
 *
 * Reusing a name is only sound while this statement is its LAST write in
 * the scope — a later reassignment would make references resolve to the
 * newer value, silently sourcing the wrong feature — so both reuse arms
 * refuse when one exists.
 */
export function resolveStatement(call: TSNode): Omit<ProducerBinding, 'bind'> | { error: string } {
  const parent = call.parent;
  const valueOfDeclarator = parent?.type === 'variable_declarator'
    ? parent.childForFieldName('value')
    : null;
  if (parent && valueOfDeclarator && sameNode(valueOfDeclarator, call)) {
    const nameNode = parent.childForFieldName('name');
    if (!nameNode || nameNode.type !== 'identifier') {
      return { error: 'the producing call is bound by a destructuring pattern — cannot reuse its variable' };
    }
    let statement = parent.parent;
    if (!statement) {
      return { error: 'malformed declaration around the producing call' };
    }
    if (statement.parent && statement.parent.type === 'export_statement') {
      statement = statement.parent;
    }
    const scope = enclosingScope(statement);
    if (isReassignedAfter(scope, nameNode.text, statement.endIndex)) {
      return { error: reassignedError(nameNode.text) };
    }
    return { call, statement, scope, varName: nameNode.text, needsBinding: false };
  }

  if (parent && parent.type === 'assignment_expression'
    && parent.parent && parent.parent.type === 'expression_statement') {
    const left = parent.childForFieldName('left');
    const right = parent.childForFieldName('right');
    if (left && left.type === 'identifier' && right && sameNode(right, call)) {
      const statement = parent.parent;
      const scope = enclosingScope(statement);
      if (isReassignedAfter(scope, left.text, statement.endIndex)) {
        return { error: reassignedError(left.text) };
      }
      return { call, statement, scope, varName: left.text, needsBinding: false };
    }
  }

  if (parent && parent.type === 'expression_statement') {
    const scope = enclosingScope(parent);
    return { call, statement: parent, scope, varName: null, needsBinding: true };
  }

  return {
    error: 'the producing call is nested inside another expression — '
      + 'assign it to a variable first, then retry',
  };
}

function reassignedError(name: string): string {
  return `'${name}' is reassigned after the producing call, so a reference would `
    + 'read the newer value — assign this call to its own variable first, then retry';
}

/**
 * Whether `name` is written again anywhere in `scope` past `afterIndex`.
 * Assignments in nested blocks rebind the same variable (barring a shadowing
 * redeclaration, rare enough to ignore), so the whole subtree is walked.
 */
function isReassignedAfter(scope: TSNode, name: string, afterIndex: number): boolean {
  for (const node of walkTree(scope)) {
    if (node.endIndex <= afterIndex) {
      continue;
    }
    if (node.type !== 'assignment_expression' && node.type !== 'augmented_assignment_expression') {
      continue;
    }
    const left = node.childForFieldName('left');
    if (left && left.type === 'identifier' && left.text === name) {
      return true;
    }
  }
  return false;
}

/**
 * Resolve every producer of `spec` to its statement and binding plan —
 * shared by create mode (insert a new statement) and edit mode (re-source an
 * existing one). Bindings must share one scope: one statement executes in
 * one place. Also validates that every selector part references a bound
 * producer.
 */
export function resolveProducerBindings(
  tree: TSTree,
  lines: string[],
  spec: ApplyFeatureEditSpec,
): { bindings: ProducerBinding[] } | { error: string } {
  const bindings: ProducerBinding[] = [];
  for (const producer of spec.producers) {
    const call = findEditableCallAt(tree, lines, producer.line);
    if (!call) {
      return { error: `no call found at line ${producer.line} — is the file in sync with the last render?` };
    }

    // Sketch, plane and wire producers (profiles, paths, plane bases) must
    // anchor their own call in both modes — a stale line pointing at some
    // other call would consume the wrong input.
    const requiredRoots = requiredChainRoots(producer.featureType);
    if (requiredRoots) {
      const root = chainRootCallee(call);
      if (root === null || !requiredRoots.includes(root)) {
        return {
          error: `the call at line ${producer.line} is ${root ? `${root}()` : 'not a feature call'}, `
            + `expected a ${requiredRoots.map(r => `${r}()`).join(' or ')} call — is the file in sync with the last render?`,
        };
      }
    }

    if (!producer.bind) {
      // Anchor-only: the statement locates the insertion scope for a
      // select()-based edit. No variable is bound, so any statement will do —
      // but the scope must be one that runs once per build, not a loop body,
      // hence the walk up to the enclosing function body (or module root).
      const statement = enclosingStatement(call);
      if (!statement) {
        return { error: `no statement found at line ${producer.line}` };
      }
      const scope = enclosingFunctionScope(statement);
      bindings.push({ call, statement, scope, varName: null, needsBinding: false, bind: false });
      continue;
    }

    const root = chainRootCallee(call);
    const validCallee = requiredRoots
      ? root !== null && requiredRoots.includes(root)
      : root !== null && producerCallees(producer.featureType).has(root);
    if (!validCallee) {
      return {
        error: `the call at line ${producer.line} is ${root ? `${root}()` : 'not a feature call'}, `
          + `expected a ${producer.featureType}()-producing call`,
      };
    }

    const resolved = resolveStatement(call);
    if ('error' in resolved) {
      return { error: resolved.error };
    }
    bindings.push({ ...resolved, bind: true });
  }

  const scope = bindings.length > 0 ? bindings[0].scope : null;
  for (const binding of bindings) {
    if (!sameNode(binding.scope, scope!)) {
      return { error: 'the picked edges come from features in different scopes' };
    }
  }

  for (const part of spec.parts) {
    if (part.producer !== null && !spec.producers[part.producer]?.bind) {
      return { error: 'malformed edit spec: a selector part references an unbound producer' };
    }
    for (const ref of part.refs ?? []) {
      if (!spec.producers[ref]?.bind) {
        return { error: 'malformed edit spec: a selector part references an unbound producer' };
      }
    }
  }

  return { bindings };
}

/**
 * Pick collision-free variable names for producers that need binding.
 * Collision-checked against every identifier in the file, matching how the
 * lint pass walks identifiers.
 */
export function allocateNames(root: TSNode, bindings: ProducerBinding[], spec: ApplyFeatureEditSpec): void {
  const used = new Set<string>();
  for (const node of walkTree(root)) {
    if (node.type === 'identifier'
      || node.type === 'property_identifier'
      || node.type === 'shorthand_property_identifier') {
      used.add(node.text);
    }
  }

  for (let i = 0; i < bindings.length; i++) {
    const binding = bindings[i];
    if (!binding.needsBinding) {
      continue;
    }
    const hint = spec.producers[i].nameHint || 'f';
    let name = hint;
    let suffix = 1;
    while (used.has(name)) {
      suffix++;
      name = `${hint}${suffix}`;
    }
    used.add(name);
    binding.varName = name;
  }
}

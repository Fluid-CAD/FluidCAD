// Producer naming and bindability probes used by selection synthesis.

import {
  chainRootCallee,
  findEditableCallAt,
  getJavaScriptParser,
  splitLines,
  walkTree,
  type TSTree,
} from '../../code-editor.ts';
import { resolveStatement, type ProducerBinding } from './bindings.ts';
import { producerCallees, requiredChainRoots } from './callees.ts';

/**
 * Build a synchronous producer→name lookup over `code` for the synthesis
 * preview, using exactly the binding rules `applyFeatureEdit` applies:
 * reuse an existing `const` name, otherwise allocate the hint suffixed past
 * every identifier already in the file. Returning the same names the
 * transform will write keeps the previewed expression (and any
 * selectorOverride the user types against it) truthful. Producers this can't
 * resolve (stale line, non-producer callee, nested call) map to null and the
 * synthesis falls back to plain hint names.
 */
export async function makeProducerNamer(
  code: string,
): Promise<(producers: { line: number; nameHint: string; featureType?: string }[]) => (string | null)[]> {
  const parser = await getJavaScriptParser();
  const tree = parser.parse(code);
  const lines = splitLines(code);

  const fileIdentifiers = new Set<string>();
  for (const node of walkTree(tree.rootNode)) {
    if (node.type === 'identifier'
      || node.type === 'property_identifier'
      || node.type === 'shorthand_property_identifier') {
      fileIdentifiers.add(node.text);
    }
  }

  return (producers) => {
    const used = new Set(fileIdentifiers);
    return producers.map(producer => {
      const resolved = resolveBindableStatementAt(tree, lines, producer);
      if (resolved === null) {
        return null;
      }
      if (!resolved.needsBinding && resolved.varName) {
        return resolved.varName;
      }
      const hint = producer.nameHint || 'f';
      let name = hint;
      let suffix = 1;
      while (used.has(name)) {
        suffix++;
        name = `${hint}${suffix}`;
      }
      used.add(name);
      return name;
    });
  };
}

/**
 * The producer's statement resolved with the transform's own binding logic,
 * or null when the transform would refuse to bind it: no producing call at
 * the line, a callee the feature type does not accept, or a statement
 * `resolveStatement` rejects (variable reassigned after the call, a
 * destructuring binding, a call nested in another expression).
 */
function resolveBindableStatementAt(
  tree: TSTree,
  lines: string[],
  producer: { line: number; featureType?: string },
): Omit<ProducerBinding, 'bind'> | null {
  const call = findEditableCallAt(tree, lines, producer.line);
  if (!call) {
    return null;
  }
  const root = chainRootCallee(call);
  // Sketch/plane/wire producers must name their own call — the pick
  // features never attribute to one, so the looser callee stays scoped
  // by type.
  const requiredRoots = requiredChainRoots(producer.featureType ?? '');
  const valid = requiredRoots
    ? root !== null && requiredRoots.includes(root)
    : root !== null && producerCallees(producer.featureType ?? '').has(root);
  if (!valid) {
    return null;
  }
  const resolved = resolveStatement(call);
  return 'error' in resolved ? null : resolved;
}

/**
 * Statement-level bindability probe for selection synthesis (the
 * SynthesizeOptions `bindable` hook): whether the transform can bind the
 * producer's statement to a variable. Built over the same file the emitted
 * statement will land in, so synthesis avoids selectors referencing a
 * producer the apply would refuse — a variable reassigned after the
 * producing call routes its picks through the variable-free global tier
 * instead of failing at apply time.
 */
export async function makeProducerBindable(
  code: string,
): Promise<(producer: { line: number; featureType?: string }) => boolean> {
  const parser = await getJavaScriptParser();
  const tree = parser.parse(code);
  const lines = splitLines(code);
  return producer => resolveBindableStatementAt(tree, lines, producer) !== null;
}

/**
 * Whether a producer's statement is already bound to a variable (`const e =
 * extrude(10)`), for the resolve-selection response: a selector the agent
 * writes against an unbound statement also needs the binding added. False
 * for a statement the transform could not bind at all.
 */
export async function makeProducerBoundProbe(
  code: string,
): Promise<(producer: { line: number; featureType?: string }) => boolean> {
  const parser = await getJavaScriptParser();
  const tree = parser.parse(code);
  const lines = splitLines(code);
  return producer => {
    const resolved = resolveBindableStatementAt(tree, lines, producer);
    return resolved !== null && !resolved.needsBinding && !!resolved.varName;
  };
}

/**
 * The variable names statements of `callee` are bound to, for dialog labels:
 * `const spine = sketch(…)` at one of `lines` resolves to `'spine'`; a bare
 * statement, a different callee at the line, or an unparsable one resolves to
 * null. Purely cosmetic — the transform re-resolves bindings at apply time.
 */
export async function resolveSketchNames(
  code: string,
  lines: number[],
  callee: string = 'sketch',
): Promise<(string | null)[]> {
  const parser = await getJavaScriptParser();
  const tree = parser.parse(code);
  const srcLines = splitLines(code);
  return lines.map(line => {
    const call = findEditableCallAt(tree, srcLines, line);
    if (!call || chainRootCallee(call) !== callee) {
      return null;
    }
    const resolved = resolveStatement(call);
    if ('error' in resolved || resolved.needsBinding) {
      return null;
    }
    return resolved.varName;
  });
}

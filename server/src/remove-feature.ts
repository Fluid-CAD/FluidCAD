// Deleting a timeline feature with its dependants — the analysis and splice
// behind the timeline's "Remove" when later features reference the removed
// one.
//
// A plain statement removal leaves every `extrude(s)`, `fillet(2, e.edges())`
// or `shell(e, …)` that named the deleted binding pointing at nothing: the
// render fails to compile and the timeline keeps serving the previous scene
// against a buffer whose rows no longer match. `analyze` therefore computes
// the closure — every statement that references a doomed binding, every
// implicit consumer of a doomed sketch, recursively — so the route's dry-run
// can put that list in front of the user, and `apply` deletes exactly that
// closure in one splice once they confirm. Sketch-body geometry is the
// exception: its constraints go silently through `SketchDeleteSweep`.

import {
  enclosingStatementOf,
  findEditableCallAt,
  getJavaScriptParser,
  spliceCode,
  splitLines,
  walkTree,
  type TSNode,
} from './code-editor.ts';
import { isReferenceUse } from './lint-fluid-js.ts';
import { StatementAnalysis } from './statement-analysis.ts';
import { SketchDeleteSweep } from './sketch-delete-sweep.ts';
import type { ApplyFeatureEditResult } from './apply-feature-edit.ts';

export type RemoveFeatureSpec = {
  /** The deleted statement, by timeline source line, with its drift guard. */
  statement: { line: number; expectedText: string };
};

/** One statement the removal takes along, for the UI's confirm list. */
export type RemoveDependent = { name: string; line: number };

export type RemoveFeatureAnalysis =
  | { ok: true; dependents: RemoveDependent[] }
  | { ok: false; reason: string };

type ResolvedRemoval = {
  lines: string[];
  /** The deleted statements — target plus dependants — in document order, outermost only. */
  doomed: TSNode[];
  /** Dependants beyond the requested statement, in document order. */
  dependents: RemoveDependent[];
  /** The target lives in a sketch body: the sketch sweep owns the edit. */
  sketchGeometry: boolean;
};

/** Scopes that bind their parameters for the code they contain. */
const PARAMETER_SCOPE_TYPES = new Set([
  'arrow_function',
  'function',
  'function_expression',
  'function_declaration',
  'generator_function',
  'generator_function_declaration',
  'method_definition',
]);

export class RemoveFeature extends StatementAnalysis {
  /**
   * Resolve a timeline line against `code`, capturing the statement's exact
   * text as the drift guard the transform re-checks against the live buffer.
   */
  static async capture(
    code: string,
    line: number,
  ): Promise<{ statement: { line: number; expectedText: string } } | { error: string }> {
    const parser = await getJavaScriptParser();
    const tree = parser.parse(code);
    const call = findEditableCallAt(tree, splitLines(code), line);
    const stmt = call ? enclosingStatementOf(call) : null;
    if (!call || !stmt) {
      return { error: `no feature call found at line ${line} — is the file in sync with the last render?` };
    }
    return { statement: { line, expectedText: code.slice(stmt.startIndex, stmt.endIndex) } };
  }

  /** Pure analysis for the route's dry-run: never touches the code. */
  static async analyze(code: string, spec: RemoveFeatureSpec): Promise<RemoveFeatureAnalysis> {
    const resolved = await RemoveFeature.resolve(code, spec);
    if ('error' in resolved) {
      return { ok: false, reason: resolved.error };
    }
    return { ok: true, dependents: resolved.dependents };
  }

  /** The transform half: delete the target and its whole dependant closure. */
  static async apply(code: string, spec: RemoveFeatureSpec): Promise<ApplyFeatureEditResult> {
    const resolved = await RemoveFeature.resolve(code, spec);
    if ('error' in resolved) {
      return { newCode: code, error: resolved.error };
    }
    if (resolved.sketchGeometry) {
      return SketchDeleteSweep.removeStatement(code, spec.statement.line);
    }
    const edits = RemoveFeature.removalEdits(code, resolved.lines, resolved.doomed);
    edits.sort((a, b) => b.start - a.start);
    let newCode = code;
    for (const e of edits) {
      newCode = spliceCode(newCode, e.start, e.end, e.text);
    }
    return { newCode };
  }

  private static async resolve(code: string, spec: RemoveFeatureSpec): Promise<ResolvedRemoval | { error: string }> {
    const parser = await getJavaScriptParser();
    const tree = parser.parse(code);
    const lines = splitLines(code);
    const { line, expectedText } = spec.statement;
    const call = findEditableCallAt(tree, lines, line);
    const target = call ? enclosingStatementOf(call) : null;
    if (!call || !target) {
      return { error: `no feature call found at line ${line} — is the file in sync with the last render?` };
    }
    if (code.slice(target.startIndex, target.endIndex) !== expectedText) {
      return { error: `the code at line ${line} changed since the timeline rendered — wait for the render and try again` };
    }
    if (RemoveFeature.enclosingSketchCall(target)) {
      return { lines, doomed: [target], dependents: [], sketchGeometry: true };
    }

    const doomed = new Map<number, TSNode>([[target.startIndex, target]]);
    const dependents: RemoveDependent[] = [];
    const inDoomed = (node: TSNode): boolean => {
      for (const stmt of doomed.values()) {
        if (RemoveFeature.within(node, stmt)) {
          return true;
        }
      }
      return false;
    };
    const addDependent = (stmt: TSNode, name: string): boolean => {
      if (doomed.has(stmt.startIndex) || inDoomed(stmt)) {
        return false;
      }
      doomed.set(stmt.startIndex, stmt);
      dependents.push({ name, line: stmt.startPosition.row + 1 });
      return true;
    };

    for (let changed = true; changed; ) {
      changed = false;
      for (const stmt of [...doomed.values()]) {
        // Every reference to a name the doomed statement binds, resolved
        // through the scope chain so a same-named binding in another part
        // body keeps its own consumers.
        const names = new Set(RemoveFeature.declaredNames(stmt));
        if (names.size > 0) {
          for (const node of walkTree(tree.rootNode)) {
            if (node.type !== 'identifier' || !names.has(node.text) || !isReferenceUse(node) || inDoomed(node)) {
              continue;
            }
            if (!RemoveFeature.resolvesTo(node, stmt, node.text)) {
              continue;
            }
            const consumer = enclosingStatementOf(node);
            if (consumer && addDependent(consumer, RemoveFeature.labelFor(consumer, node.text))) {
              changed = true;
            }
          }
        }
        // The active-sketch link `sketch(…)` → `extrude(10)` is invisible to
        // identifier analysis: pair the doomed sketch with the siblings that
        // consume it implicitly.
        if (RemoveFeature.isSketchProducer(stmt) && stmt.parent) {
          const siblings = stmt.parent.namedChildren;
          const declByName = new Map<string, TSNode>();
          for (const sibling of siblings) {
            for (const name of RemoveFeature.declaredNames(sibling)) {
              declByName.set(name, sibling);
            }
          }
          for (const sibling of siblings) {
            if (sibling.startIndex <= stmt.startIndex || doomed.has(sibling.startIndex)) {
              continue;
            }
            if (!RemoveFeature.isImplicitConsumer(tree, lines, declByName, sibling)) {
              continue;
            }
            const producer = RemoveFeature.nearestPrecedingSketch(siblings, sibling);
            if (producer && RemoveFeature.sameSpan(producer, stmt)
              && addDependent(sibling, RemoveFeature.labelFor(sibling, 'feature'))) {
              changed = true;
            }
          }
        }
      }
    }

    // A dependant nested inside another doomed statement is deleted with
    // its container: splicing it separately would overlap.
    const all = [...doomed.values()].sort((a, b) => a.startIndex - b.startIndex);
    const outermost = all.filter((stmt) => !all.some((other) => other !== stmt && RemoveFeature.within(stmt, other)));
    const outermostLines = new Set(outermost.map((stmt) => stmt.startPosition.row + 1));
    return {
      lines,
      doomed: outermost,
      dependents: dependents
        .filter((d) => outermostLines.has(d.line))
        .sort((a, b) => a.line - b.line),
      sketchGeometry: false,
    };
  }

  /**
   * Does the identifier `ref` (named `name`) resolve to the binding
   * `declStmt` makes? True when the walk up from the reference reaches the
   * block that holds `declStmt` without passing a closer block or function
   * that binds the same name.
   */
  private static resolvesTo(ref: TSNode, declStmt: TSNode, name: string): boolean {
    const declScope = declStmt.parent;
    if (!declScope) {
      return false;
    }
    for (let cur = ref.parent; cur; cur = cur.parent) {
      if (cur.type === 'statement_block' || cur.type === 'program') {
        if (RemoveFeature.sameSpan(cur, declScope)) {
          return true;
        }
        if (cur.namedChildren.some((child) => RemoveFeature.declaredNames(child).includes(name))) {
          return false;
        }
      } else if (PARAMETER_SCOPE_TYPES.has(cur.type) && RemoveFeature.parameterNames(cur).includes(name)) {
        return false;
      }
    }
    return false;
  }

  private static parameterNames(fn: TSNode): string[] {
    const single = fn.childForFieldName('parameter');
    if (single) {
      return [single.text];
    }
    const params = fn.childForFieldName('parameters');
    if (!params) {
      return [];
    }
    const out: string[] = [];
    for (const node of walkTree(params)) {
      if (node.type === 'identifier' || node.type === 'shorthand_property_identifier_pattern') {
        out.push(node.text);
      }
    }
    return out;
  }
}

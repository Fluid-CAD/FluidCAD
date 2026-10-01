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
//
// A removed hole also takes the connectors it was placed at, when nothing
// else reads them (`HoleConnectors`). Those are not dependants — nothing
// breaks if they stay — so they go without a warning, but only the ones the
// spec lists: who reads a connector by name is a question about the whole
// workspace, answered where the spec is captured, not in this transform.

import {
  enclosingStatementOf,
  findEditableCallAt,
  getJavaScriptParser,
  spliceCode,
  splitLines,
  walkTree,
  type TSNode,
} from './code-editor/index.ts';
import { isReferenceUse } from './lint-fluid-js.ts';
import { StatementAnalysis } from './statement-analysis.ts';
import { SketchDeleteSweep } from './sketch-delete-sweep.ts';
import { HoleConnectors, type HoleConnector } from './hole-connectors.ts';
import type { ApplyFeatureEditResult } from './apply-feature-edit/index.ts';
import { RegionDeclarations } from './apply-feature-edit/region-declarations.ts';

export type RemoveFeatureSpec = {
  /** The deleted statement, by timeline source line, with its drift guard. */
  statement: { line: number; expectedText: string };
  /**
   * The connector statements the removal may take along — the removed
   * holes' placements nothing else in the workspace reads — each with its
   * drift guard. The transform re-checks every one against the buffer it
   * edits: a connector that gained a reader, or no longer stands where it
   * was captured, stays. Absent, every connector stays.
   */
  connectors?: { line: number; expectedText: string }[];
};

/** One statement the removal takes along, for the UI's confirm list. */
export type RemoveDependent = { name: string; line: number };

export type RemoveFeatureAnalysis =
  | { ok: true; dependents: RemoveDependent[]; connectors: RemoveDependent[] }
  | { ok: false; reason: string };

/**
 * Narrows the connectors a removal orphans in its own file to the ones no
 * other file reads — see `WorkspaceConnectorReads.unread`.
 */
export type UnreadConnectors = (connectors: HoleConnector[]) => Promise<HoleConnector[]>;

type ResolvedRemoval = {
  lines: string[];
  /** The deleted statements — target plus dependants — in document order, outermost only. */
  doomed: TSNode[];
  /** Dependants beyond the requested statement, in document order. */
  dependents: RemoveDependent[];
  /** The connectors of the removed holes that go along — already among `doomed`. */
  connectors: HoleConnector[];
  /** The target lives in a sketch body: the sketch sweep owns the edit. */
  sketchGeometry: boolean;
};

export class RemoveFeature extends StatementAnalysis {
  /**
   * Resolve a timeline line against `code`, capturing the statement's exact
   * text as the drift guard the transform re-checks against the live buffer,
   * and the connectors the removal orphans. `unread` drops the connectors
   * other files read by name; without it only `code` is consulted.
   */
  static async capture(
    code: string,
    line: number,
    unread: UnreadConnectors = async (connectors) => connectors,
  ): Promise<RemoveFeatureSpec | { error: string }> {
    const parser = await getJavaScriptParser();
    const tree = parser.parse(code);
    const call = findEditableCallAt(tree, splitLines(code), line);
    const stmt = call ? enclosingStatementOf(call) : null;
    if (!call || !stmt) {
      return { error: `no feature call found at line ${line} — is the file in sync with the last render?` };
    }
    const statement = { line, expectedText: code.slice(stmt.startIndex, stmt.endIndex) };
    const resolved = await RemoveFeature.resolve(code, { statement }, () => true);
    const orphaned = 'error' in resolved ? [] : await unread(resolved.connectors);
    return { statement, connectors: orphaned.map(RemoveFeature.connectorGuard) };
  }

  /** Pure analysis for the route's dry-run: never touches the code. */
  static async analyze(code: string, spec: RemoveFeatureSpec): Promise<RemoveFeatureAnalysis> {
    const resolved = await RemoveFeature.resolve(code, spec);
    if ('error' in resolved) {
      return { ok: false, reason: resolved.error };
    }
    return {
      ok: true,
      dependents: resolved.dependents,
      connectors: resolved.connectors.map((connector) => ({
        name: connector.variable,
        line: connector.statement.startPosition.row + 1,
      })),
    };
  }

  /** A connector statement as the spec addresses it: its line and exact text. */
  private static connectorGuard(connector: HoleConnector): { line: number; expectedText: string } {
    return { line: connector.statement.startPosition.row + 1, expectedText: connector.statement.text };
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
    // The region declarations only the removed statements consumed go too:
    // a `region('r1', …)` row nobody names any more is noise in the sketch.
    const regionNames = resolved.doomed.flatMap(RemoveFeature.regionNamesOf);
    return { newCode: await RegionDeclarations.pruneUnreferenced(newCode, regionNames) };
  }

  /** The names a statement's `.region(…)` chains carry. */
  private static regionNamesOf(statement: TSNode): string[] {
    const names: string[] = [];
    for (const node of walkTree(statement)) {
      if (node.type !== 'call_expression') {
        continue;
      }
      const fn = node.childForFieldName('function');
      if (!fn || fn.type !== 'member_expression' || fn.childForFieldName('property')?.text !== 'region') {
        continue;
      }
      for (const arg of node.childForFieldName('arguments')?.namedChildren ?? []) {
        if (arg.type === 'string') {
          const fragment = arg.namedChildren.find(c => c.type === 'string_fragment');
          names.push(fragment ? fragment.text : '');
        }
      }
    }
    return names;
  }

  /**
   * The removal's closure against `code`. `takes` says which of the
   * connectors the closure orphans go along: the ones the spec lists, unless
   * the caller is the capture that builds that list.
   */
  private static async resolve(
    code: string,
    spec: RemoveFeatureSpec,
    takes: (connector: HoleConnector) => boolean = (connector) => {
      const guard = RemoveFeature.connectorGuard(connector);
      return (spec.connectors ?? []).some((c) => c.line === guard.line && c.expectedText === guard.expectedText);
    },
  ): Promise<ResolvedRemoval | { error: string }> {
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
      return { lines, doomed: [target], dependents: [], connectors: [], sketchGeometry: true };
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
    const connectors = HoleConnectors.orphanedBy(tree, outermost, takes);
    return {
      lines,
      doomed: [...outermost, ...connectors.map((connector) => connector.statement)]
        .sort((a, b) => a.startIndex - b.startIndex),
      dependents: dependents
        .filter((d) => outermostLines.has(d.line))
        .sort((a, b) => a.line - b.line),
      connectors,
      sketchGeometry: false,
    };
  }
}

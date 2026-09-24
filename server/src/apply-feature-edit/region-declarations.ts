// Region declarations: turning a dialog's region picks into `region()` rows
// of the profile sketch and the names the feature's `.region(…)` chain
// carries — staged before the consuming statement renders, the way loft
// connections stage their sketch exports.
//
// A pick arrives as a boundary in wire form (the statements on the region's
// outer loop by source line, each with its side) and/or the name of a
// declaration that already lists it. The pass binds every referenced
// statement through the sketch's shared rail (an unbound statement gets
// `const l3 = `, a looped one a collector array), renders the boundary as
// the declaration's arguments (`l6, l2, far(c1)`, `r1.top()`), reuses a
// declaration whose arguments already read the same, allocates `r<n>` for
// the rest and appends their rows at the end of the sketch body. In edit
// mode the declarations the statement alone referenced and no longer does
// are removed. The caller's tracked lines are relocated across the edit.

import {
  ensureSymbolImport,
  findEditableCallAt,
  findSketchBody,
  getJavaScriptParser,
  indentOf,
  isBreakpointStatement,
  joinLines,
  spliceCode,
  splitLines,
  stringLiteralValue,
  walkTree,
  type TSNode,
} from '../code-editor/index.ts';
import { collectIdentifiers } from '../sketch-names.ts';
import { EmissionRefusal, calleeName, chainBase } from '../sketch-solved-edit/index.ts';
import { StatementBinder } from '../sketch-solved-edit/statement-binder.ts';
import { decomposeChain } from './ast/chain.ts';
import { chainRootCall } from './ast/nodes.ts';
import { stringArgValue } from './ast/args.ts';
import { relocateCallLines } from './call-site-relocation.ts';
import { quoteRegionName } from './render/chains.ts';
import type { ApplyFeatureEditSpec } from './spec.ts';
import type { RegionItemRefSpec, RegionPickSpec } from './value-expr.ts';

/** The features whose statements carry a `.region(…)` chain. */
type RegionFeature = 'extrude' | 'revolve' | 'sweep' | 'wrap';
const REGION_FEATURES: RegionFeature[] = ['extrude', 'revolve', 'sweep', 'wrap'];

/** Region names the pass allocates: `r1`, `r2`, … past the highest the sketch already declares. */
const ALLOCATED_NAME = /^r(\d+)$/;

/** Callees whose sub-edges have an accessor the declaration can name. */
const MACRO_CALLEES = new Set(['rect']);
const REFERENCE_CALLEES = new Set(['project', 'intersect']);
const OFFSET_CALLEES = new Set(['offset']);

/** One `region('name', …)` row of the sketch body as the pass reads it. */
type ExistingDeclaration = {
  name: string;
  /** The row in the source, or null for one this pass is about to write. */
  statement: TSNode | null;
  /** The argument texts, whitespace-normalized, sorted — the boundary as a set. */
  args: string[];
};

/** What one create or edit spec asks the pass to do. */
type RegionWork = {
  feature: RegionFeature;
  picks: RegionPickSpec[];
  sketchLine: number | null;
  /** Edit mode: the statement whose chain is being replaced. */
  editLine: number | null;
};

export type DeclaredNames = { code: string; names: string[] };

export class RegionDeclarations {
  /** The region picks a spec carries, or null when it carries none (the chain is kept or absent). */
  static workOf(spec: ApplyFeatureEditSpec): RegionWork | null {
    const feature = REGION_FEATURES.find(f => f === spec.feature);
    if (!feature) {
      return null;
    }
    if (spec.edit) {
      const options = spec.edit[feature] as { regionPicks?: RegionPickSpec[]; regionSketch?: { line: number } } | undefined;
      if (!options || options.regionPicks === undefined) {
        return null;
      }
      return { feature, picks: options.regionPicks, sketchLine: options.regionSketch?.line ?? null, editLine: spec.edit.line };
    }
    const options = spec[feature] as { regionPicks?: RegionPickSpec[]; regionSketch?: { line: number } } | undefined;
    if (!options || options.regionPicks === undefined) {
      return null;
    }
    return { feature, picks: options.regionPicks, sketchLine: options.regionSketch?.line ?? null, editLine: null };
  }

  /**
   * Stage the declarations a spec's picks need and hand back the spec with
   * the names in place of the picks, its line references relocated across
   * the sketch edit. A spec without picks passes through untouched.
   */
  static async prepare(code: string, spec: ApplyFeatureEditSpec): Promise<
    { code: string; spec: ApplyFeatureEditSpec } | { error: string }
  > {
    const work = RegionDeclarations.workOf(spec);
    if (!work) {
      return { code, spec };
    }
    // Names alone, matching what the statement already carries, need no
    // sketch: the chain is simply rewritten. Everything else writes into the
    // sketch body and has to know which sketch.
    const nameOnly = work.picks.every(pick => pick.name !== undefined && (pick.items === undefined || pick.items.length === 0));
    let names: string[];
    let staged = code;
    if (nameOnly && (work.editLine === null || work.sketchLine === null
      || await sameNames(code, work.editLine, work.picks.map(p => p.name!)))) {
      // Declared names only: the chain is rewritten as given. An edit whose
      // sketch is known still goes through `declare` below when the names
      // changed, so the declarations it dropped can be pruned.
      names = work.picks.map(p => p.name!);
    } else {
      if (work.sketchLine === null) {
        return { error: 'the region picks need their profile sketch — re-open the dialog and pick the regions again' };
      }
      const declared = await RegionDeclarations.declare(code, work.sketchLine, work.picks, work.editLine);
      if ('error' in declared) {
        return declared;
      }
      staged = declared.code;
      names = declared.names;
    }

    const tracked = [
      ...spec.producers.map(producer => producer.line),
      ...(spec.edit ? [spec.edit.line] : []),
      ...(spec.activePart ? [spec.activePart.line] : []),
    ];
    const relocated = staged === code ? new Map(tracked.map(line => [line, line])) : await relocateCallLines(code, staged, tracked);
    if (!relocated) {
      return { error: 'could not relocate the consuming statement after the region declarations were written — re-render and try again' };
    }
    const producers = spec.producers.map(producer => ({ ...producer, line: relocated.get(producer.line)! }));
    const withNames = (options: Record<string, unknown>) => {
      const { regionPicks: _picks, regionSketch: _sketch, ...rest } = options;
      return { ...rest, regions: names };
    };
    if (spec.edit) {
      const edit = {
        ...spec.edit,
        line: relocated.get(spec.edit.line)!,
        [work.feature]: withNames(spec.edit[work.feature] as Record<string, unknown>),
      };
      const activePart = spec.activePart ? { ...spec.activePart, line: relocated.get(spec.activePart.line)! } : undefined;
      return { code: staged, spec: { ...spec, producers, edit, activePart } as ApplyFeatureEditSpec };
    }
    const activePart = spec.activePart ? { ...spec.activePart, line: relocated.get(spec.activePart.line)! } : undefined;
    return {
      code: staged,
      spec: { ...spec, producers, activePart, [work.feature]: withNames(spec[work.feature] as Record<string, unknown>) } as ApplyFeatureEditSpec,
    };
  }

  /**
   * The names the picks would get, without editing anything — what a
   * statement preview shows before Apply. Falls back to the picks' own
   * names (or `r?`) when the sketch cannot be read.
   */
  static async planNames(code: string | null, sketchLine: number, picks: RegionPickSpec[]): Promise<string[]> {
    if (picks.length === 0) {
      return [];
    }
    if (code) {
      const declared = await RegionDeclarations.declare(code, sketchLine, picks, null);
      if (!('error' in declared)) {
        return declared.names;
      }
    }
    return picks.map(pick => pick.name ?? 'r?');
  }

  /**
   * Remove the `region()` declarations named in `names` that no `.region(…)`
   * chain of the file references any more — the tail of a feature removal.
   * Declarations other statements still name stay; so does everything else.
   */
  static async pruneUnreferenced(code: string, names: string[]): Promise<string> {
    if (names.length === 0) {
      return code;
    }
    const parser = await getJavaScriptParser();
    const tree = parser.parse(code);
    const referenced = referencedRegionNames(tree.rootNode, null);
    const doomed = readDeclarations(tree.rootNode).filter(d => names.includes(d.name) && !referenced.has(d.name));
    if (doomed.length === 0) {
      return code;
    }
    return removeStatementRows(code, doomed.map(d => d.statement));
  }

  /**
   * Write the declarations for `picks` into the sketch at `sketchLine` and
   * return the names in pick order. `editLine` names the statement whose old
   * chain is being replaced: the declarations only it referenced, and it
   * no longer does, go.
   */
  static async declare(
    code: string,
    sketchLine: number,
    picks: RegionPickSpec[],
    editLine: number | null,
  ): Promise<DeclaredNames | { error: string }> {
    const parser = await getJavaScriptParser();
    const tree = parser.parse(code);
    const lines = splitLines(code);
    const sketchCall = findEditableCallAt(tree, lines, sketchLine);
    const root = sketchCall ? chainRootCall(sketchCall) : null;
    if (!sketchCall || !root || calleeName(root) !== 'sketch') {
      return { error: `no sketch statement at line ${sketchLine} — the source changed since the regions were picked` };
    }
    const body = findSketchBody(sketchCall);
    if (!body) {
      return { error: `the sketch at line ${sketchLine} has an expression body — give it a block body so its regions can be declared` };
    }

    const existing = readDeclarations(body);
    const used = collectIdentifiers(tree);
    const binder = new StatementBinder(tree, lines, body, used);
    const names: string[] = [];
    const rows: string[] = [];
    let usesFar = false;
    const taken = new Set(existing.map(d => d.name));
    try {
      for (const pick of picks) {
        const items = pick.items ?? [];
        if (items.length === 0) {
          if (pick.name === undefined) {
            return { error: 'a region pick names a declared region or lists its boundary' };
          }
          if (!names.includes(pick.name)) {
            names.push(pick.name);
          }
          continue;
        }
        const args = items.map(item => renderItem(item, binder));
        usesFar = usesFar || items.some(item => item.far);
        const wanted = normalizeArgs(args);
        let name = pick.name !== undefined && existing.some(d => d.name === pick.name && sameArgs(d.args, wanted))
          ? pick.name
          : existing.find(d => sameArgs(d.args, wanted))?.name;
        if (name === undefined) {
          name = allocateName(taken);
          existing.push({ name, statement: null, args: wanted });
          rows.push(`region(${quoteRegionName(name)}, ${args.join(', ')});`);
        }
        if (!names.includes(name)) {
          names.push(name);
        }
      }
    } catch (error) {
      if (error instanceof EmissionRefusal) {
        return { error: error.message };
      }
      throw error;
    }

    // Edit mode: the declarations the old chain named, the new one does not,
    // and nothing else in the file references, are removed with the chain.
    const removals: TSNode[] = [];
    if (editLine !== null) {
      const editCall = findEditableCallAt(tree, lines, editLine);
      const oldNames = editCall ? regionChainNames(editCall) : [];
      const referencedElsewhere = referencedRegionNames(tree.rootNode, editCall);
      for (const old of oldNames) {
        if (names.includes(old) || referencedElsewhere.has(old)) {
          continue;
        }
        const declaration = existing.find(d => d.name === old && d.statement !== null);
        if (declaration?.statement) {
          removals.push(declaration.statement);
        }
      }
    }

    // Binder insertions first (back to front), then the new rows at the tail
    // of the body — past every referenced statement — then the removals,
    // whose rows are mapped past both.
    let result = code;
    for (const edit of [...binder.edits].sort((a, b) => b.start - a.start)) {
      result = spliceCode(result, edit.start, edit.start, edit.text);
    }
    const resultLines = splitLines(result);
    const shiftRow = (row: number) => binder.shiftRow(row);
    let insertRow = Infinity;
    if (rows.length > 0) {
      const children = body.namedChildren.filter(node => node.type !== 'comment');
      const breakpoint = children.find(isBreakpointStatement);
      let indent: string;
      if (breakpoint) {
        insertRow = shiftRow(breakpoint.startPosition.row);
        indent = indentOf(resultLines, insertRow);
      } else if (children.length > 0) {
        const last = children[children.length - 1];
        insertRow = last.type === 'return_statement'
          ? shiftRow(last.startPosition.row)
          : shiftRow(last.endPosition.row + 1);
        indent = indentOf(resultLines, shiftRow(last.startPosition.row));
      } else {
        insertRow = shiftRow(body.startPosition.row + 1);
        indent = indentOf(resultLines, shiftRow(body.startPosition.row)) + '  ';
      }
      for (const anchor of binder.anchors) {
        const after = shiftRow(anchor.after);
        if (after > insertRow) {
          insertRow = after;
          indent = indentOf(resultLines, shiftRow(anchor.indentRow));
        }
      }
      resultLines.splice(insertRow, 0, ...rows.map(text => `${indent}${text}`));
    }
    const removedRows = removals
      .map(statement => ({ start: shiftRow(statement.startPosition.row), span: statement.endPosition.row - statement.startPosition.row + 1 }))
      .map(({ start, span }) => ({ start: start >= insertRow ? start + rows.length : start, span }))
      .sort((a, b) => b.start - a.start);
    for (const { start, span } of removedRows) {
      resultLines.splice(start, span);
    }
    result = joinLines(resultLines);
    result = await ensureSymbolImport(result, 'region', 'fluidcad/core');
    if (usesFar) {
      result = await ensureSymbolImport(result, 'far', 'fluidcad/core');
    }
    return { code: result, names };
  }
}

/** Render one boundary item as a declaration argument: `l6`, `far(c1)`, `r1.top()`, `prj.ref(2)`. */
function renderItem(item: RegionItemRefSpec, binder: StatementBinder): string {
  const name = binder.bind(item.line, item.occurrence, (entityCall) => {
    const callee = calleeName(chainBase(entityCall));
    if (callee !== item.callee) {
      throw new EmissionRefusal(callee
        ? `line ${item.line} is a ${callee}() statement now — the source changed since the regions were picked`
        : `line ${item.line} is not a sketch entity statement — the source changed since the regions were picked`);
    }
    return callee;
  }, `no statement at line ${item.line} — the source changed since the regions were picked`);
  let expression = name;
  if (item.edge) {
    expression += edgeAccessor(item.callee, item.edge);
  }
  return item.far ? `far(${expression})` : expression;
}

/**
 * The accessor naming one edge of a multi-edge statement: a macro slot's
 * method (`.top()`, `.corner(2)`), a reference's `.ref(i)`, an offset's
 * `.edge(i)`. A statement whose edges have no accessor is named whole — the
 * bare reference covers every edge of it on the region.
 */
function edgeAccessor(callee: string, edge: string): string {
  const [head] = edge.split('.');
  const index = /^e(\d+)$/.exec(head);
  if (MACRO_CALLEES.has(callee)) {
    const corner = /^corner(\d+)$/.exec(head);
    if (corner) {
      return `.corner(${corner[1]})`;
    }
    return index ? '' : `.${head}()`;
  }
  if (index && REFERENCE_CALLEES.has(callee)) {
    return `.ref(${Number(index[1]) - 1})`;
  }
  if (index && OFFSET_CALLEES.has(callee)) {
    return `.edge(${Number(index[1]) - 1})`;
  }
  return '';
}

/** The `region('name', …)` rows directly in a sketch body (or anywhere under `scope`). */
function readDeclarations(scope: TSNode): ExistingDeclaration[] {
  const out: ExistingDeclaration[] = [];
  for (const node of walkTree(scope)) {
    if (node.type !== 'expression_statement') {
      continue;
    }
    const call = node.namedChild(0);
    if (!call || call.type !== 'call_expression' || calleeName(call) !== 'region') {
      continue;
    }
    const args = call.childForFieldName('arguments')?.namedChildren.filter(a => a.type !== 'comment') ?? [];
    const name = args.length > 0 ? stringLiteralValue(args[0]) : null;
    if (name === null) {
      continue;
    }
    out.push({ name, statement: node, args: normalizeArgs(args.slice(1).map(a => a.text)) });
  }
  return out;
}

/** Argument texts as a comparable set: whitespace collapsed, sorted. */
function normalizeArgs(args: string[]): string[] {
  return args.map(a => a.replace(/\s+/g, '')).sort();
}

function sameArgs(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** `r<n>`, one past the highest `r<n>` in `taken`; added to `taken`. */
function allocateName(taken: Set<string>): string {
  let highest = 0;
  for (const name of taken) {
    const match = ALLOCATED_NAME.exec(name);
    if (match) {
      highest = Math.max(highest, Number(match[1]));
    }
  }
  const name = `r${highest + 1}`;
  taken.add(name);
  return name;
}

/** The string arguments of the `.region(…)` segment of the chain rooted at `call`. */
function regionChainNames(call: TSNode): string[] {
  const chain = decomposeChain(call);
  const segment = chain?.members.find(m => m.name === 'region');
  return segment ? segment.args.map(stringArgValue).filter((n): n is string => n !== null) : [];
}

/** Every region name a `.region(…)` chain in the file mentions, outside the chain rooted at `except`. */
function referencedRegionNames(root: TSNode, except: TSNode | null): Set<string> {
  const names = new Set<string>();
  for (const node of walkTree(root)) {
    if (node.type !== 'call_expression') {
      continue;
    }
    const fn = node.childForFieldName('function');
    if (!fn || fn.type !== 'member_expression' || fn.childForFieldName('property')?.text !== 'region') {
      continue;
    }
    if (except && node.startIndex >= except.startIndex && node.endIndex <= except.endIndex) {
      continue;
    }
    for (const arg of node.childForFieldName('arguments')?.namedChildren ?? []) {
      const name = stringArgValue(arg);
      if (name !== null) {
        names.add(name);
      }
    }
  }
  return names;
}

/** Whether the chain at `editLine` names exactly `names` in `.region(…)` already. */
async function sameNames(code: string, editLine: number, names: string[]): Promise<boolean> {
  const parser = await getJavaScriptParser();
  const tree = parser.parse(code);
  const call = findEditableCallAt(tree, splitLines(code), editLine);
  if (!call) {
    return false;
  }
  const current = regionChainNames(call);
  return current.length === names.length && current.every((n, i) => n === names[i]);
}

/** Delete whole statement rows (0-based start rows with their span), back to front. */
function removeRows(code: string, starts: number[], spans: number[]): string {
  const rows = splitLines(code);
  const order = starts.map((start, i) => ({ start, span: spans[i] })).sort((a, b) => b.start - a.start);
  for (const { start, span } of order) {
    rows.splice(start, span);
  }
  return joinLines(rows);
}

/** Delete the rows of whole statements from `code` (statements from a parse of `code`). */
function removeStatementRows(code: string, statements: TSNode[]): string {
  return removeRows(
    code,
    statements.map(s => s.startPosition.row),
    statements.map(s => s.endPosition.row - s.startPosition.row + 1),
  );
}

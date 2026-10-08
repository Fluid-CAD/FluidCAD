import { ensureSymbolImport, getJavaScriptParser, spliceCode, type TSNode, type TSTree } from './code-editor/index.ts';
import {
  appendStatementInScope,
  baseCallName,
  chainBaseCall,
  enclosingStatement,
  findBaseStatement,
  findChainAt,
  firstHiddenAnchor,
  formatNumber,
  resolveStatementBinding,
} from './assembly-chain-tools.ts';

/**
 * Relation types the kernel's `relation()` accepts — restated here
 * (mirroring `RelationRules.TYPES` in lib/features/relation.ts) so the
 * transform stays a dependency-free string function.
 */
export const ASSEMBLY_RELATION_TYPES = ['gear', 'rack-and-pinion'] as const;

export type AssemblyRelationType = (typeof ASSEMBLY_RELATION_TYPES)[number];

/** Mate types each side of a relation accepts — the kernel's RelationRules table. */
const ROTATING_MATES = ['revolute', 'cylindrical'];
const SLIDING_MATES = ['slider', 'cylindrical'];

/**
 * One side of a relation statement: the `mate()` statement starting on
 * `mateLine` (its serialized sourceLocation). The side dereferences as that
 * statement's `const` binding; a bare `mate(...)` expression statement gets
 * `const mate1 = ` prepended, like an unbound `insert()`.
 */
export type RelationMateRef = { mateLine: number };

export type AssemblyRelationPayload = {
  type: AssemblyRelationType;
  mateA: RelationMateRef;
  mateB: RelationMateRef;
  /** Gear: turns of B per turn of A. Rack-and-pinion: travel per revolution. Positive. */
  ratio: number;
  /** `.reverse()` — omitted or false writes nothing. */
  reverse?: boolean;
};

/**
 * The relation dialog's edit payload — rides `ApplyFeatureEditSpec` as a
 * side-channel like `assemblyMate`: every other spec field is ignored and
 * the transform below runs instead. `create` appends a fresh statement in
 * the mates' scope; `edit` re-renders the statement at `sourceLine` in place
 * from the dialog's full state.
 */
export type AssemblyRelationEditSpec = {
  create?: AssemblyRelationPayload;
  edit?: AssemblyRelationPayload & {
    /** 1-based row the `relation()` statement starts on (serialized sourceLocation.line). */
    sourceLine: number;
  };
};

export type AssemblyRelationEditResult = { newCode: string; error?: string };

/**
 * Write or rewrite a `relation()` statement:
 *
 *     const pinion = mate('revolute', base1.connectors.axle, small1.connectors.bore);
 *     const wheel = mate('revolute', base1.connectors.axle2, big1.connectors.bore);
 *     relation('gear', pinion, wheel, 0.5).reverse();
 *
 * Each side resolves through the `const` binding of its `mate()` statement;
 * a bare `mate(...)` expression statement gets a fresh `mate<N>` binding
 * prepended so the relation has a name to pass.
 */
export async function applyAssemblyRelationEdit(
  code: string,
  spec: AssemblyRelationEditSpec,
): Promise<AssemblyRelationEditResult> {
  const payload = spec.create ?? spec.edit;
  if (!payload) {
    return { newCode: code, error: 'empty assembly-relation spec' };
  }
  const invalid = validateRelationPayload(payload);
  if (invalid) {
    return { newCode: code, error: invalid };
  }

  // Resolve line-addressed targets before touching imports — a fresh
  // `import { relation }` line would shift every row the spec points at.
  let working = code;
  const bindings: string[] = [];
  const anchorLines = [payload.mateA.mateLine, payload.mateB.mateLine];
  const mateTypes: (string | null)[] = [];
  for (const line of anchorLines) {
    const parser = await getJavaScriptParser();
    const found = findBaseStatement(parser.parse(working), line, 'mate');
    if ('error' in found) {
      return { newCode: code, error: `${found.error} — the source may have shifted; re-render and try again` };
    }
    mateTypes.push(literalMateType(working, found.base));
    const bound = await resolveStatementBinding(working, line, 'mate', 'mate');
    if ('error' in bound) {
      return { newCode: code, error: bound.error };
    }
    working = bound.newCode;
    bindings.push(bound.name);
  }
  const sideProblem = sideProblemFor(payload.type, mateTypes[0], mateTypes[1]);
  if (sideProblem) {
    return { newCode: code, error: sideProblem };
  }

  const statement = renderRelationStatement(payload, bindings[0], bindings[1]);
  const result = spec.edit
    ? await replaceRelationStatement(working, spec.edit.sourceLine, statement, anchorLines)
    : await appendStatementInScope(working, statement, anchorLines[0], anchorLines[1]);
  if (result.error) {
    return { newCode: code, error: result.error.replace("connectors' instances", 'mates') };
  }
  const out = await ensureSymbolImport(result.newCode, 'relation');
  return { newCode: out };
}

export function validateRelationPayload(payload: AssemblyRelationPayload): string | null {
  if (!ASSEMBLY_RELATION_TYPES.includes(payload.type)) {
    return `unknown relation type "${payload.type}"`;
  }
  for (const side of [payload.mateA, payload.mateB]) {
    if (!side || !Number.isInteger(side.mateLine) || side.mateLine < 1) {
      return 'a relation side needs the line its mate() statement starts on';
    }
  }
  if (payload.mateA.mateLine === payload.mateB.mateLine) {
    return 'a mate cannot be related to itself — pick two different mates';
  }
  if (typeof payload.ratio !== 'number' || !Number.isFinite(payload.ratio)) {
    return 'the relation ratio must be a finite number';
  }
  if (payload.ratio <= 0) {
    return payload.type === 'gear'
      ? 'the gear ratio must be positive — use Reverse to turn the second gear the other way'
      : 'the travel per revolution must be positive — use Reverse to run the rack the other way';
  }
  if (payload.reverse !== undefined && typeof payload.reverse !== 'boolean') {
    return 'relation reverse must be a boolean';
  }
  return null;
}

/**
 * The kernel's per-type side rule, applied to the mate types read off the
 * statements (`null` when a type is not a string literal — the kernel then
 * decides at render time).
 */
function sideProblemFor(type: AssemblyRelationType, mateTypeA: string | null, mateTypeB: string | null): string | null {
  if (mateTypeA !== null && !ROTATING_MATES.includes(mateTypeA)) {
    return type === 'gear'
      ? `the first mate is '${mateTypeA}' — a gear couples two revolute or cylindrical mates`
      : `the first mate is '${mateTypeA}' — the pinion side must be a revolute or cylindrical mate`;
  }
  const allowedB = type === 'gear' ? ROTATING_MATES : SLIDING_MATES;
  if (mateTypeB !== null && !allowedB.includes(mateTypeB)) {
    return type === 'gear'
      ? `the second mate is '${mateTypeB}' — a gear couples two revolute or cylindrical mates`
      : `the second mate is '${mateTypeB}' — the rack side must be a slider or cylindrical mate`;
  }
  return null;
}

/** The mate type a `mate('type', …)` call names, when its first argument is a string literal. */
function literalMateType(code: string, base: TSNode): string | null {
  const first = base.childForFieldName('arguments')?.namedChildren.find(c => c.type !== 'comment');
  if (!first || first.type !== 'string') {
    return null;
  }
  return code.slice(first.startIndex + 1, first.endIndex - 1);
}

export function renderRelationStatement(
  payload: AssemblyRelationPayload,
  a: string,
  b: string,
): string {
  let statement = `relation('${payload.type}', ${a}, ${b}, ${formatNumber(payload.ratio)})`;
  if (payload.reverse) {
    statement += '.reverse()';
  }
  return `${statement};`;
}

/**
 * Replace the whole `relation()` statement starting on `sourceLine` in
 * place. The statement stays put, so both mate bindings must be visible
 * from there — re-pointing a root relation at a mate inside an `assembly()`
 * body would render a ReferenceError.
 */
async function replaceRelationStatement(
  code: string,
  sourceLine: number,
  statement: string,
  anchorLines: number[],
): Promise<AssemblyRelationEditResult> {
  const parser = await getJavaScriptParser();
  const tree: TSTree = parser.parse(code);
  const tail = findChainAt(tree, sourceLine);
  if (!tail || baseCallName(chainBaseCall(tail)) !== 'relation') {
    return { newCode: code, error: `no relation() statement found on line ${sourceLine} — the source may have shifted; re-render and try again` };
  }
  const target = enclosingStatement(tail);
  if (!target) {
    return { newCode: code, error: `could not resolve the relation() statement on line ${sourceLine}` };
  }
  const hidden = firstHiddenAnchor(tree, target, anchorLines);
  if (hidden !== null) {
    return {
      newCode: code,
      error: `the mate() on line ${hidden} lives in a different assembly body than this relation — pick mates from the relation's own scope`,
    };
  }
  return { newCode: spliceCode(code, target.startIndex, target.endIndex, statement) };
}

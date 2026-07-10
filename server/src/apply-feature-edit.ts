import {
  getJavaScriptParser,
  ensureSymbolImport,
  findEditableCallAt,
  indentOf,
  splitLines,
  spliceCode,
  walkTree,
  type TSNode,
} from './code-editor.ts';

/**
 * Mirror of `lib/selection/types.ts` `ApplyFeatureEditSpec` — the wire
 * contract between the synthesis layer and this transform. Kept structural
 * here so the transform stays a dependency-free string function.
 */
export type ApplyFeatureEditSpec = {
  feature: 'fillet' | 'chamfer' | 'shell' | 'sketch' | 'extrude' | 'sweep';
  /** Numeric parameter (radius/distance/thickness); absent for sketch. */
  value?: number;
  /** Extrude-only payload; the profile is a sketch, not a pick selection. */
  extrude?: ExtrudeEditOptions;
  /** Sweep-only payload; `parts` (if any) render the path selector. */
  sweep?: SweepEditOptions;
  filePath: string;
  producers: {
    line: number;
    column: number;
    featureType: string;
    nameHint: string;
    /**
     * True when the call must be bound to a variable. False marks an
     * anchor-only entry whose statement just locates the insertion scope
     * (used when every part is a global `select()` expression).
     */
    bind: boolean;
  }[];
  parts: {
    /** Index into `producers`, or null for a global `select()` part. */
    producer: number | null;
    accessor: string;
    indices: number[] | null;
    /** Rendered filter-builder arguments, e.g. `edge().circle(5)`. */
    filterArgs: string | null;
  }[];
  /** Extra symbols the statement references (`select`, `edge`, `face`). */
  imports: string[];
  /**
   * User-edited replacement for the whole selector argument list. Emitted
   * verbatim instead of rendering `parts`; extra imports are derived from
   * its text.
   */
  rawArgs?: string;
};

/**
 * How an extrude statement is rendered and placed. The single producer is the
 * profile *sketch* call. `implicit` inserts at the end of the sketch's scope
 * and consumes it as the last sketch (`extrude(25)`); `bound` binds the sketch
 * to a variable and inserts directly after its statement (`const s = …;
 * extrude(25, s)`) so a later active sketch stays active.
 */
export type ExtrudeEditOptions = {
  op: 'add' | 'remove' | 'new';
  /** Extrusion distance; null renders a through-all `cut()` (remove only). */
  distance: number | null;
  /** `.thin(a)` / `.thin(a, b)` offsets, or null for a plain extrude. */
  thin: [number] | [number, number] | null;
  profile: 'implicit' | 'bound';
};

/**
 * How a sweep statement is rendered and placed: `sweep(<path>[, <profile>])`
 * plus `.thin(…)` / `.remove()` / `.new()` chains. The profile is a sketch —
 * `implicit` consumes the last sketch (an anchor-only producer verifies it),
 * `{producer}` binds that sketch to a variable. The path is either a bound
 * sketch producer or the selector rendered from `parts` (edge picks). With
 * both ends being sketches and a bound profile, the statement inserts right
 * after the later of the two so a later active sketch stays active; every
 * other combination inserts at end of scope, where an implicit profile is
 * the last sketch and a selector path is known to resolve.
 */
export type SweepEditOptions = {
  op: 'add' | 'remove' | 'new';
  thin: [number] | [number, number] | null;
  profile: 'implicit' | { producer: number };
  path: { kind: 'sketch'; producer: number } | { kind: 'selector' };
};

export type ApplyFeatureEditResult = {
  newCode: string;
  error?: string;
};

/**
 * Chain-root callees this transform will bind a variable to. Guards against a
 * stale or clone-inherited source line pointing at some unrelated call (e.g.
 * `repeat(...)`): binding `const e = repeat(...)` and emitting `e.endEdges()`
 * would produce broken code, so we refuse instead.
 */
const PRODUCER_CALLEES = new Set([
  'extrude', 'cut', 'revolve', 'sweep', 'loft', 'rib', 'wrap', 'shell',
]);

type ProducerBinding = {
  call: TSNode;
  statement: TSNode;
  scope: TSNode;
  varName: string | null;
  needsBinding: boolean;
  /** False for anchor-only entries — never named, never referenced by parts. */
  bind: boolean;
};

/**
 * Apply a synthesized feature statement (fillet/chamfer/shell/sketch) to
 * source text: bind each producer call to a variable (reusing an existing
 * `const`, or prepending `const <name> = ` to a bare expression statement),
 * append the feature statement at the end of the producers' enclosing scope,
 * and ensure the feature is imported. A sketch statement carries an empty
 * multi-line callback body instead of a numeric parameter.
 *
 * Pure string-in/string-out; returns `{ newCode: code, error }` and changes
 * nothing when the edit cannot be applied safely.
 */
export async function applyFeatureEdit(
  code: string,
  spec: ApplyFeatureEditSpec,
): Promise<ApplyFeatureEditResult> {
  if (spec.feature === 'extrude') {
    // Extrude takes no selector parts: its single producer is the profile
    // sketch (implicit consumption or a bound variable), not a pick selection.
    if (!spec.extrude || spec.producers.length !== 1 || spec.parts.length !== 0) {
      return { newCode: code, error: 'malformed extrude edit spec' };
    }
  } else if (spec.feature === 'sweep') {
    const sw = spec.sweep;
    const sketchProducer = (i: number) => Number.isInteger(i) && i >= 0
      && i < spec.producers.length && spec.producers[i].featureType === 'sketch';
    const valid = sw !== undefined
      && spec.producers.length > 0
      && (sw.path.kind === 'selector'
        ? spec.parts.length >= 1
        : spec.parts.length === 0 && sketchProducer(sw.path.producer))
      && (sw.profile === 'implicit' || sketchProducer(sw.profile.producer));
    if (!valid) {
      return { newCode: code, error: 'malformed sweep edit spec' };
    }
  } else if (!spec.producers.length || !spec.parts.length) {
    return { newCode: code, error: 'empty edit spec' };
  }
  if (spec.feature === 'sketch' && spec.parts.length > 1 && !spec.rawArgs?.trim()) {
    return { newCode: code, error: 'sketch takes a single face selection' };
  }

  const parser = await getJavaScriptParser();
  const tree = parser.parse(code);
  const lines = splitLines(code);

  const bindings: ProducerBinding[] = [];
  for (const producer of spec.producers) {
    const call = findEditableCallAt(tree, lines, producer.line);
    if (!call) {
      return { newCode: code, error: `no call found at line ${producer.line} — is the file in sync with the last render?` };
    }

    // Sketch producers (extrude/sweep profiles, sweep paths) must anchor the
    // sketch call itself in both modes — a stale line pointing at some other
    // call would consume the wrong profile or path.
    if (producer.featureType === 'sketch') {
      const root = chainRootCallee(call);
      if (root !== 'sketch') {
        return {
          newCode: code,
          error: `the call at line ${producer.line} is ${root ? `${root}()` : 'not a feature call'}, `
            + `expected a sketch() call — is the file in sync with the last render?`,
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
        return { newCode: code, error: `no statement found at line ${producer.line}` };
      }
      const scope = enclosingFunctionScope(statement);
      bindings.push({ call, statement, scope, varName: null, needsBinding: false, bind: false });
      continue;
    }

    const root = chainRootCallee(call);
    const validCallee = producer.featureType === 'sketch'
      ? root === 'sketch'
      : root !== null && PRODUCER_CALLEES.has(root);
    if (!validCallee) {
      return {
        newCode: code,
        error: `the call at line ${producer.line} is ${root ? `${root}()` : 'not a feature call'}, `
          + `expected a ${producer.featureType}()-producing call`,
      };
    }

    const resolved = resolveStatement(call);
    if ('error' in resolved) {
      return { newCode: code, error: resolved.error };
    }
    bindings.push({ ...resolved, bind: true });
  }

  const scope = bindings[0].scope;
  for (const binding of bindings) {
    if (!sameNode(binding.scope, scope)) {
      return { newCode: code, error: 'the picked edges come from features in different scopes' };
    }
  }

  for (const part of spec.parts) {
    if (part.producer !== null && !spec.producers[part.producer]?.bind) {
      return { newCode: code, error: 'malformed edit spec: a selector part references an unbound producer' };
    }
  }

  allocateNames(tree.rootNode, bindings, spec);

  const insertion = resolveInsertion(spec, bindings, scope, lines);
  const statementText = buildStatement(spec, bindings, insertion.indent);
  const useSemicolon = bindings.some(b => b.statement.text.trimEnd().endsWith(';'));

  type Edit = { index: number; text: string };
  const edits: Edit[] = [
    { index: insertion.index, text: insertion.wrap(statementText + (useSemicolon ? ';' : '')) },
  ];
  for (const binding of bindings) {
    if (binding.needsBinding) {
      edits.push({ index: binding.call.startIndex, text: `const ${binding.varName} = ` });
    }
  }
  edits.sort((a, b) => b.index - a.index);

  let result = code;
  for (const edit of edits) {
    result = spliceCode(result, edit.index, edit.index, edit.text);
  }

  result = await ensureSymbolImport(result, statementCallee(spec));
  const imports = new Set(spec.imports ?? []);
  if (spec.rawArgs?.trim()) {
    for (const symbol of importsForRawArgs(spec.rawArgs)) {
      imports.add(symbol);
    }
  }
  for (const symbol of imports) {
    result = await ensureSymbolImport(result, symbol, MODULE_FOR_IMPORT[symbol] ?? 'fluidcad/core');
  }
  return { newCode: result };
}

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
      const call = findEditableCallAt(tree, lines, producer.line);
      if (!call) {
        return null;
      }
      const root = chainRootCallee(call);
      // Sketch producers only name extrude profiles — the pick features never
      // attribute to a sketch, so the looser callee stays scoped by type.
      const valid = producer.featureType === 'sketch' ? root === 'sketch' : root !== null && PRODUCER_CALLEES.has(root);
      if (!valid) {
        return null;
      }
      const resolved = resolveStatement(call);
      if ('error' in resolved) {
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
 * The variable names sketch statements are bound to, for dialog labels:
 * `const spine = sketch(…)` at one of `lines` resolves to `'spine'`; a bare
 * sketch statement, a non-sketch line, or an unparsable one resolves to null.
 * Purely cosmetic — the transform re-resolves bindings itself at apply time.
 */
export async function resolveSketchNames(code: string, lines: number[]): Promise<(string | null)[]> {
  const parser = await getJavaScriptParser();
  const tree = parser.parse(code);
  const srcLines = splitLines(code);
  return lines.map(line => {
    const call = findEditableCallAt(tree, srcLines, line);
    if (!call || chainRootCallee(call) !== 'sketch') {
      return null;
    }
    const resolved = resolveStatement(call);
    if ('error' in resolved || resolved.needsBinding) {
      return null;
    }
    return resolved.varName;
  });
}

export type ExtractedParam = {
  name: string;
  value: number;
  /** Set for `param("Label", 12)` declarations — resolve against the registry. */
  label?: string;
};

/** Numeric literal text of a node, accepting a unary minus. */
function numericLiteralText(node: TSNode): string | null {
  if (node.type === 'number') {
    return node.text;
  }
  if (node.type === 'unary_expression' && node.text.startsWith('-')
    && node.namedChildren.length === 1 && node.namedChildren[0].type === 'number') {
    return node.text;
  }
  return null;
}

/**
 * Extract the file's top-level numeric constants for parameter linking:
 * synthesis renders a dimension constant as the user's variable when the
 * values match exactly. Two initializer forms qualify — a plain numeric
 * literal (`const height = 30`) and a `param("Label", 12)` declaration
 * (which returns the resolved number at runtime; the label lets the caller
 * substitute the registry's current, override-aware value). Only
 * program-root declarations qualify — they are in scope wherever the
 * feature statement is inserted; function-local variables are skipped
 * rather than risking a reference error.
 */
export async function extractNumericParams(code: string): Promise<ExtractedParam[]> {
  const parser = await getJavaScriptParser();
  const tree = parser.parse(code);
  const params: ExtractedParam[] = [];

  for (const statement of tree.rootNode.namedChildren) {
    if (statement.type !== 'lexical_declaration' && statement.type !== 'variable_declaration') {
      continue;
    }
    for (const declarator of statement.namedChildren) {
      if (declarator.type !== 'variable_declarator') {
        continue;
      }
      const name = declarator.childForFieldName('name');
      const value = declarator.childForFieldName('value');
      if (!name || name.type !== 'identifier' || !value) {
        continue;
      }

      const literal = numericLiteralText(value);
      if (literal !== null) {
        const parsed = Number(literal);
        if (Number.isFinite(parsed)) {
          params.push({ name: name.text, value: parsed });
        }
        continue;
      }

      // const x = param("Label", 12[, ...]) — link by the param's value.
      if (value.type === 'call_expression') {
        const fn = value.childForFieldName('function');
        const args = value.childForFieldName('arguments');
        if (!fn || fn.type !== 'identifier' || fn.text !== 'param' || !args) {
          continue;
        }
        const [labelNode, defaultNode] = args.namedChildren;
        if (!labelNode || labelNode.type !== 'string' || !defaultNode) {
          continue;
        }
        const defaultText = numericLiteralText(defaultNode);
        if (defaultText === null) {
          continue;
        }
        const parsed = Number(defaultText);
        if (Number.isFinite(parsed)) {
          params.push({
            name: name.text,
            value: parsed,
            label: labelNode.text.slice(1, -1),
          });
        }
      }
    }
  }
  return params;
}

/**
 * Replace `param()`-declared defaults with the registry's current values —
 * the scene was built with those, so linking against the source default when
 * an override is active would emit a filter that matches nothing. Params
 * whose current value is not a finite number (select/text) never link; a
 * label the registry doesn't know keeps the source default.
 */
export function resolveParamValues(
  entries: ExtractedParam[],
  definitions: { label: string; currentValue: unknown }[],
): { name: string; value: number }[] {
  const byLabel = new Map(definitions.map(d => [d.label, d.currentValue]));
  const resolved: { name: string; value: number }[] = [];
  for (const entry of entries) {
    if (entry.label === undefined || !byLabel.has(entry.label)) {
      resolved.push({ name: entry.name, value: entry.value });
      continue;
    }
    const current = byLabel.get(entry.label);
    if (typeof current === 'number' && Number.isFinite(current)) {
      resolved.push({ name: entry.name, value: current });
    }
  }
  return resolved;
}

/**
 * web-tree-sitter mints a fresh wrapper object on every node access, so
 * reference equality between wrappers is meaningless — compare by span.
 */
function sameNode(a: TSNode, b: TSNode): boolean {
  return a.type === b.type && a.startIndex === b.startIndex && a.endIndex === b.endIndex;
}

/** Root identifier of a call chain: `extrude(10).drill()` → `extrude`. */
function chainRootCallee(call: TSNode): string | null {
  let current: TSNode | null = call;
  while (current && current.type === 'call_expression') {
    const fn = current.childForFieldName('function');
    if (!fn) {
      return null;
    }
    if (fn.type === 'identifier') {
      return fn.text;
    }
    if (fn.type === 'member_expression') {
      current = fn.childForFieldName('object');
      continue;
    }
    return null;
  }
  return null;
}

/**
 * Locate the statement holding the producer call and how to bind it:
 * - `const x = <call>` → reuse `x` (statement is the declaration, or the
 *   `export` statement wrapping it);
 * - `<call>;` as a bare expression statement → prepend `const <name> = `
 *   (same-row prepend, so later source lines don't shift);
 * - anything else (the call is nested inside another expression) → refuse
 *   rather than rewrite user code speculatively.
 */
function resolveStatement(call: TSNode): Omit<ProducerBinding, 'bind'> | { error: string } {
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
    return { call, statement, scope, varName: nameNode.text, needsBinding: false };
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

/** Nearest enclosing statement_block or the program root. */
function enclosingScope(node: TSNode): TSNode {
  let current: TSNode | null = node.parent;
  while (current) {
    if (current.type === 'statement_block' || current.type === 'program') {
      return current;
    }
    current = current.parent;
  }
  return node;
}

/** Nearest ancestor that is a direct child of a statement_block or program. */
function enclosingStatement(node: TSNode): TSNode | null {
  let current: TSNode | null = node;
  while (current && current.parent) {
    if (current.parent.type === 'statement_block' || current.parent.type === 'program') {
      return current;
    }
    current = current.parent;
  }
  return null;
}

const FUNCTION_NODE_TYPES = new Set([
  'function_declaration', 'function_expression', 'arrow_function',
  'method_definition', 'generator_function', 'generator_function_declaration',
]);

/**
 * Nearest enclosing scope that executes once per build: a function body or
 * the program root, skipping loop/conditional statement blocks. A statement
 * inserted at the end of this scope runs after the whole model is built.
 */
function enclosingFunctionScope(node: TSNode): TSNode {
  let scope = enclosingScope(node);
  while (scope.type === 'statement_block') {
    const parent = scope.parent;
    if (parent && FUNCTION_NODE_TYPES.has(parent.type)) {
      return scope;
    }
    scope = enclosingScope(scope);
  }
  return scope;
}

/**
 * Pick collision-free variable names for producers that need binding.
 * Collision-checked against every identifier in the file, matching how the
 * lint pass walks identifiers.
 */
function allocateNames(root: TSNode, bindings: ProducerBinding[], spec: ApplyFeatureEditSpec): void {
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

/** The function the rendered statement calls — extrude's remove op is `cut()`. */
function statementCallee(spec: ApplyFeatureEditSpec): string {
  if (spec.feature === 'extrude') {
    return spec.extrude!.op === 'remove' ? 'cut' : 'extrude';
  }
  return spec.feature;
}

/**
 * Render a sweep statement: `sweep(<path>[, <profile>])` plus `.thin(…)` and
 * the `.remove()` / `.new()` operation chains. Shared with the route's
 * preview so the previewed text is exactly what the transform writes.
 */
export function renderSweepStatement(
  sw: Pick<SweepEditOptions, 'op' | 'thin'>,
  pathExpr: string,
  profileVar: string | null,
): string {
  const args = [pathExpr];
  if (profileVar) {
    args.push(profileVar);
  }
  let statement = `sweep(${args.join(', ')})`;
  if (sw.thin) {
    statement += `.thin(${sw.thin.map(formatNumber).join(', ')})`;
  }
  if (sw.op === 'remove') {
    statement += '.remove()';
  } else if (sw.op === 'new') {
    statement += '.new()';
  }
  return statement;
}

/**
 * Render an extrude statement from its options: `extrude(25)` / `cut()`
 * (through-all) / `extrude(25, s)` for a bound profile, plus `.thin(…)` and
 * `.new()` chains. Shared with the route's preview so the previewed text is
 * exactly what the transform writes.
 */
export function renderExtrudeStatement(ext: ExtrudeEditOptions, profileVar: string | null): string {
  const callee = ext.op === 'remove' ? 'cut' : 'extrude';
  const callArgs: string[] = [];
  if (ext.distance !== null) {
    callArgs.push(formatNumber(ext.distance));
  }
  if (ext.profile === 'bound') {
    callArgs.push(profileVar ?? 's');
  }
  let statement = `${callee}(${callArgs.join(', ')})`;
  if (ext.thin) {
    statement += `.thin(${ext.thin.map(formatNumber).join(', ')})`;
  }
  if (ext.op === 'new') {
    statement += '.new()';
  }
  return statement;
}

/**
 * Render the feature statement. Most features are
 * `<feature>(<value>, <selectors>)`; `sketch` instead wraps the selector with
 * an empty callback body — a blank line for the user's first sketch entity,
 * with the closing brace at the statement's own indent; `extrude` renders
 * from its options — `extrude(25)` / `cut()` (through-all) / a bound profile
 * variable as the trailing argument — plus `.thin(…)` and `.new()` chains.
 */
function buildStatement(spec: ApplyFeatureEditSpec, bindings: ProducerBinding[], indent: string): string {
  if (spec.feature === 'extrude') {
    return renderExtrudeStatement(spec.extrude!, bindings[0].varName);
  }
  if (spec.feature === 'sweep') {
    const sw = spec.sweep!;
    const pathExpr = sw.path.kind === 'sketch'
      ? bindings[sw.path.producer].varName!
      : renderSelectorArgs(spec, bindings);
    const profileVar = sw.profile === 'implicit' ? null : bindings[sw.profile.producer].varName!;
    return renderSweepStatement(sw, pathExpr, profileVar);
  }
  const args = renderSelectorArgs(spec, bindings);
  if (spec.feature === 'sketch') {
    return `sketch(${args}, () => {\n\n${indent}})`;
  }
  return `${spec.feature}(${formatNumber(spec.value)}, ${args})`;
}

/** The selector argument list: the user-edited override, or rendered parts. */
function renderSelectorArgs(spec: ApplyFeatureEditSpec, bindings: ProducerBinding[]): string {
  const rawArgs = spec.rawArgs?.trim();
  return rawArgs ?? spec.parts.map(part => {
    const selectorArgs = part.indices ? part.indices.join(', ') : (part.filterArgs ?? '');
    if (part.producer === null) {
      return `select(${selectorArgs})`;
    }
    const name = bindings[part.producer].varName;
    return `${name}.${part.accessor}(${selectorArgs})`;
  }).join(', ');
}

const MODULE_FOR_IMPORT: Record<string, string> = {
  select: 'fluidcad/core',
  edge: 'fluidcad/filters',
  face: 'fluidcad/filters',
};

/**
 * Symbols a user-edited argument list references. The synthesized path
 * computes imports kernel-side; an override is free text, so they are
 * re-derived here from the same three call spellings.
 */
function importsForRawArgs(rawArgs: string): string[] {
  const symbols: string[] = [];
  for (const symbol of Object.keys(MODULE_FOR_IMPORT)) {
    if (new RegExp(`\\b${symbol}\\(`).test(rawArgs)) {
      symbols.push(symbol);
    }
  }
  return symbols;
}

function formatNumber(value: number | undefined): string {
  return Number.isFinite(value) ? String(value) : '1';
}

/** Insertion point directly after `statement`, at its own indent. */
function afterStatementInsertion(
  statement: TSNode,
  lines: string[],
): { index: number; indent: string; wrap: (stmt: string) => string } {
  const indent = indentOf(lines, statement.startPosition.row);
  return { index: statement.endIndex, indent, wrap: (stmt) => `\n${indent}${stmt}` };
}

/**
 * Where the feature statement goes. Statements whose inputs are all explicit
 * sketch variables insert directly after the later input — a later active
 * sketch stays the active one (bound-profile extrude; bound-profile sweep
 * with a sketch path). Everything else inserts at end of scope: a selector
 * must resolve on the final model, and an implicit profile must consume the
 * scope's last sketch.
 */
function resolveInsertion(
  spec: ApplyFeatureEditSpec,
  bindings: ProducerBinding[],
  scope: TSNode,
  lines: string[],
): { index: number; indent: string; wrap: (stmt: string) => string } {
  if (spec.feature === 'extrude' && spec.extrude!.profile === 'bound') {
    return afterStatementInsertion(bindings[0].statement, lines);
  }
  if (spec.feature === 'sweep') {
    const sw = spec.sweep!;
    if (sw.path.kind === 'sketch' && sw.profile !== 'implicit') {
      const path = bindings[sw.path.producer].statement;
      const profile = bindings[sw.profile.producer].statement;
      return afterStatementInsertion(path.endIndex >= profile.endIndex ? path : profile, lines);
    }
  }
  return findInsertionPoint(scope, lines, bindings);
}

/**
 * End-of-scope insertion point: after the scope's last statement, but before
 * a trailing `return`. Inserting at the end matches what the user saw — the
 * picked edges survived to the final model, so resolving the selection after
 * the last statement is guaranteed to find them. `indent` is the statement
 * indent at the insertion point, for statements with internal newlines.
 */
function findInsertionPoint(
  scope: TSNode,
  lines: string[],
  bindings: ProducerBinding[],
): { index: number; indent: string; wrap: (stmt: string) => string } {
  const children = scope.namedChildren;
  const last = children.length > 0 ? children[children.length - 1] : null;

  if (last && last.type === 'return_statement') {
    const indent = indentOf(lines, last.startPosition.row);
    return { index: last.startIndex, indent, wrap: (stmt) => `${stmt}\n${indent}` };
  }

  const anchor = last ?? bindings[0].statement;
  const indent = indentOf(lines, anchor.startPosition.row);
  return { index: anchor.endIndex, indent, wrap: (stmt) => `\n${indent}${stmt}` };
}

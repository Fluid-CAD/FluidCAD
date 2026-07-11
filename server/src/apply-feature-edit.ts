import {
  getJavaScriptParser,
  ensureSymbolImport,
  findEditableCallAt,
  indentOf,
  isBreakpointStatement,
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
  feature: 'fillet' | 'chamfer' | 'shell' | 'sketch' | 'extrude' | 'sweep' | 'loft' | 'plane';
  /** Numeric parameter (radius/distance/thickness); absent for sketch. */
  value?: number;
  /**
   * Pick-less sketch (empty `producers`/`parts`): the origin plane the
   * statement targets; absent renders the bare default-plane form.
   */
  sketchPlane?: 'xy' | 'xz' | 'yz';
  /** Extrude-only payload; the profile is a sketch, not a pick selection. */
  extrude?: ExtrudeEditOptions;
  /** Sweep-only payload; `parts` (if any) render the path selector. */
  sweep?: SweepEditOptions;
  /** Loft-only payload; each `parts` entry renders one profile's selector. */
  loft?: LoftEditOptions;
  /** Plane-only payload; each `parts` entry renders one base's selector. */
  plane?: PlaneEditOptions;
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
  /**
   * In-place statement edit (timeline double-click → edit dialog): rewrite
   * the existing feature statement at this location instead of inserting a
   * new one. `producers`/`parts` are ignored (send them empty).
   */
  edit?: FeatureStatementEditTarget;
};

/**
 * Dialog edits to apply over the feature statement at `line`. Only the
 * options the dialogs expose ride here — argument expressions they don't
 * edit (profiles, paths, selector args) are re-read from the statement at
 * apply time and preserved verbatim. Fillet/chamfer/shell reuse the spec's
 * top-level `value` (and `rawArgs` when the selector text was edited).
 */
export type FeatureStatementEditTarget = {
  line: number;
  column: number;
  extrude?: {
    op: 'add' | 'remove' | 'new';
    distance: number | null;
    distance2: number | null;
    symmetric: boolean;
    draft: number | null;
    drill: boolean;
    thin: [number] | [number, number] | null;
  };
  sweep?: {
    op: 'add' | 'remove' | 'new';
    thin: [number] | [number, number] | null;
  };
  loft?: {
    op: 'add' | 'remove' | 'new';
    thin: [number] | [number, number] | null;
    startCondition?: LoftConditionSpec;
    endCondition?: LoftConditionSpec;
  };
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
  /**
   * Opposite-direction distance; non-null renders the two-distance form
   * `extrude(d1, d2)`. Excludes `symmetric` and a through-all `distance`.
   */
  distance2: number | null;
  /** `.symmetric()` — the distance is split equally across the sketch plane. */
  symmetric: boolean;
  /** `.draft(angle)` taper in degrees, or null for a straight extrude. */
  draft: number | null;
  /** False renders `.drill(false)` — inner closed regions extrude as solid. */
  drill: boolean;
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

/**
 * How a loft statement is rendered and placed: `loft(<profile>, <profile>, …)`
 * plus `.guides(…)` / `.startCondition(…)` / `.endCondition(…)` /
 * `.thin(…)` / `.remove()` / `.new()` chains. Profiles are ordered —
 * their order IS the argument order. Every profile is explicit (loft never
 * consumes the last sketch): a sketch profile binds its producer to a
 * variable; a selector profile renders one entry of `parts` (a picked face).
 * Guides are always bound sketch producers, at most two — the kernel takes
 * no more — and exclude thin mode (`Loft.validate` throws on the combination).
 * All-sketch lofts insert directly after the latest input statement (guides
 * included — the statement references their variables) so a later active
 * sketch stays active; any selector profile forces end-of-scope insertion,
 * where the picked faces are known to resolve.
 */
export type LoftEditOptions = {
  op: 'add' | 'remove' | 'new';
  thin: [number] | [number, number] | null;
  profiles: ({ kind: 'sketch'; producer: number } | { kind: 'selector'; part: number })[];
  /** Guide-curve sketches the loft surface must follow, in argument order. */
  guides?: { kind: 'sketch'; producer: number }[];
  /** Takeoff constraint at the first profile; absent renders no chain. */
  startCondition?: LoftConditionSpec;
  /** Arrival constraint at the last profile; absent renders no chain. */
  endCondition?: LoftConditionSpec;
};

/**
 * One rendered `.startCondition(…)`/`.endCondition(…)` chain. 'none' is
 * represented by absence — the API's 'none' merely clears a condition, so the
 * dialog never writes it. A magnitude of 1 (the API default) is omitted.
 */
export type LoftConditionSpec = {
  type: 'normal' | 'tangent';
  magnitude: number;
};

/**
 * One base of a plane statement: a standard origin plane (renders as its
 * string literal, no producer involved), a picked face/edge rendered from a
 * `parts` entry, or an existing plane feature bound to a variable.
 */
export type PlaneBaseSpec =
  | { kind: 'standard'; plane: 'xy' | 'xz' | 'yz' }
  | { kind: 'selector'; part: number }
  | { kind: 'plane'; producer: number };

/**
 * How a plane statement is rendered and placed: `plane(<base>)` for an offset
 * plane — with a bare numeric offset (`plane('xy', 10)`) or a transform
 * options object when rotation rides along — `plane(<b1>, <b2>, …)` for a
 * mid plane, or `plane(<edge>, <position>)` for a plane normal to an edge at
 * a 0–1 position along it. A mid base must be plane-like, so a picked
 * face/edge selector is wrapped in its own `plane(…)` there. With only
 * standard bases the spec carries no producers at all and the statement
 * appends at top level; with plane-variable bases and no selectors it inserts
 * right after the latest input statement; any selector base forces
 * end-of-scope insertion, where the picked geometry is known to resolve.
 */
export type PlaneEditOptions = {
  type: 'offset' | 'mid' | 'edge';
  /** Normal offset distance; null/0 renders none. Offset/mid types only. */
  offset: number | null;
  /** Rotation in degrees around the plane's local axes; null/0 renders none. */
  rotateX: number | null;
  rotateY: number | null;
  rotateZ: number | null;
  /** Normalized 0–1 position along the edge (edge type only). */
  position?: number | null;
  /** One base for an offset/edge plane, two for a mid plane. */
  bases: PlaneBaseSpec[];
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
  if (spec.edit) {
    return applyStatementEdit(code, spec);
  }
  if (spec.feature === 'sketch' && spec.producers.length === 0 && spec.parts.length === 0) {
    return applyPlaneSketch(code, spec.sketchPlane);
  }
  if (spec.feature === 'extrude') {
    // Extrude takes no selector parts: its single producer is the profile
    // sketch (implicit consumption or a bound variable), not a pick selection.
    if (!spec.extrude || spec.producers.length !== 1 || spec.parts.length !== 0) {
      return { newCode: code, error: 'malformed extrude edit spec' };
    }
  } else if (spec.feature === 'sweep') {
    const sw = spec.sweep;
    const sketchProducer = (i: number) => isSketchProducer(spec, i);
    const valid = sw !== undefined
      && spec.producers.length > 0
      && (sw.path.kind === 'selector'
        ? spec.parts.length >= 1
        : spec.parts.length === 0 && sketchProducer(sw.path.producer))
      && (sw.profile === 'implicit' || sketchProducer(sw.profile.producer));
    if (!valid) {
      return { newCode: code, error: 'malformed sweep edit spec' };
    }
  } else if (spec.feature === 'loft') {
    const lo = spec.loft;
    const selectorParts = lo?.profiles
      ?.filter((p): p is { kind: 'selector'; part: number } => p?.kind === 'selector')
      .map(p => p.part) ?? [];
    const guides = lo?.guides ?? [];
    const valid = lo !== undefined
      && spec.producers.length > 0
      && Array.isArray(lo.profiles) && lo.profiles.length >= 2
      && lo.profiles.every(p => p?.kind === 'sketch'
        ? isSketchProducer(spec, p.producer)
        : p?.kind === 'selector' && Number.isInteger(p.part) && p.part >= 0 && p.part < spec.parts.length)
      // Every selector part belongs to exactly one profile.
      && selectorParts.length === spec.parts.length
      && new Set(selectorParts).size === selectorParts.length
      && Array.isArray(guides) && guides.length <= 2
      && guides.every(g => g?.kind === 'sketch' && isSketchProducer(spec, g.producer))
      && [lo.startCondition, lo.endCondition].every(c => c === undefined
        || ((c.type === 'normal' || c.type === 'tangent')
          && Number.isFinite(c.magnitude) && c.magnitude !== 0));
    if (!valid) {
      return { newCode: code, error: 'malformed loft edit spec' };
    }
    if (guides.length > 0 && lo.thin) {
      return { newCode: code, error: 'loft guides cannot be combined with thin walls' };
    }
  } else if (spec.feature === 'plane') {
    const pl = spec.plane;
    const selectorParts = pl?.bases
      ?.filter((b): b is { kind: 'selector'; part: number } => b?.kind === 'selector')
      .map(b => b.part) ?? [];
    const valid = pl !== undefined
      && Array.isArray(pl.bases)
      && (pl.type === 'mid' ? pl.bases.length === 2
        : (pl.type === 'offset' || pl.type === 'edge') && pl.bases.length === 1)
      && pl.bases.every(b =>
        b?.kind === 'standard' ? (b.plane === 'xy' || b.plane === 'xz' || b.plane === 'yz')
          : b?.kind === 'plane' ? isPlaneProducer(spec, b.producer)
            : b?.kind === 'selector' && Number.isInteger(b.part) && b.part >= 0 && b.part < spec.parts.length)
      // Every selector part belongs to exactly one base.
      && selectorParts.length === spec.parts.length
      && new Set(selectorParts).size === selectorParts.length
      && [pl.offset, pl.rotateX, pl.rotateY, pl.rotateZ]
        .every(v => v === null || (typeof v === 'number' && Number.isFinite(v)))
      // The edge form is a picked edge plus a normalized position — the
      // second argument slot is taken, so no offset/rotation can ride.
      && (pl.type !== 'edge' || (
        pl.bases[0]?.kind === 'selector'
        && typeof pl.position === 'number' && Number.isFinite(pl.position)
        && pl.position >= 0 && pl.position <= 1
        && [pl.offset, pl.rotateX, pl.rotateY, pl.rotateZ].every(v => v === null)));
    if (!valid) {
      return { newCode: code, error: 'malformed plane edit spec' };
    }
    // Standard-only bases involve no existing statement — the plane appends
    // at top level like the pick-less sketch.
    if (spec.producers.length === 0 && spec.parts.length === 0) {
      return appendTopLevelStatement(
        code,
        () => renderPlaneStatement(pl, renderPlaneBaseExprs(pl, spec.parts, () => null)),
        'plane',
      );
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

    // Sketch and plane producers (profiles, paths, plane bases) must anchor
    // their own call in both modes — a stale line pointing at some other call
    // would consume the wrong input.
    const requiredRoot = requiredChainRoot(producer.featureType);
    if (requiredRoot) {
      const root = chainRootCallee(call);
      if (root !== requiredRoot) {
        return {
          newCode: code,
          error: `the call at line ${producer.line} is ${root ? `${root}()` : 'not a feature call'}, `
            + `expected a ${requiredRoot}() call — is the file in sync with the last render?`,
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
    const validCallee = requiredRoot
      ? root === requiredRoot
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
 * The pick-less sketch statement: no face selector — `sketch('<plane>', ()
 * => {})` on an origin plane (bare `sketch(() => {})` when no plane rides
 * the spec), appended at top level.
 */
async function applyPlaneSketch(
  code: string,
  plane: 'xy' | 'xz' | 'yz' | undefined,
): Promise<ApplyFeatureEditResult> {
  const args = plane ? `'${plane}', ` : '';
  return appendTopLevelStatement(code, indent => `sketch(${args}() => {\n\n${indent}})`, 'sketch');
}

/**
 * Append a statement that references no existing code (pick-less sketch,
 * standard-base plane) after the file's last statement — before the first
 * `breakpoint();` (a paused build never runs statements after it) or a
 * trailing `return`, matching the file's semicolon style — or as an empty
 * file's first. `statementFor` receives the insertion indent (for multi-line
 * bodies) and renders without the trailing semicolon.
 */
async function appendTopLevelStatement(
  code: string,
  statementFor: (indent: string) => string,
  callee: string,
): Promise<ApplyFeatureEditResult> {
  const parser = await getJavaScriptParser();
  const tree = parser.parse(code);
  const lines = splitLines(code);
  const children = tree.rootNode.namedChildren;
  const last = children.length > 0 ? children[children.length - 1] : null;

  let result: string;
  if (!last) {
    result = spliceCode(code, code.length, code.length, `${statementFor('')};\n`);
  } else {
    const useSemicolon = children.some(c => c.text.trimEnd().endsWith(';'));
    const before = children.find(isBreakpointStatement)
      ?? (last.type === 'return_statement' ? last : null);
    const indent = indentOf(lines, (before ?? last).startPosition.row);
    const statement = `${statementFor(indent)}${useSemicolon ? ';' : ''}`;
    result = before
      ? spliceCode(code, before.startIndex, before.startIndex, `${statement}\n${indent}`)
      : spliceCode(code, last.endIndex, last.endIndex, `\n${indent}${statement}`);
  }
  return { newCode: await ensureSymbolImport(result, callee) };
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
      // Sketch/plane producers must name their own call — the pick features
      // never attribute to one, so the looser callee stays scoped by type.
      const requiredRoot = requiredChainRoot(producer.featureType ?? '');
      const valid = requiredRoot ? root === requiredRoot : root !== null && PRODUCER_CALLEES.has(root);
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

/** Whether producer index `i` is a valid sketch producer of `spec`. */
function isSketchProducer(spec: ApplyFeatureEditSpec, i: number): boolean {
  return Number.isInteger(i) && i >= 0 && i < spec.producers.length
    && spec.producers[i].featureType === 'sketch';
}

/** Whether producer index `i` is a valid plane producer of `spec`. */
function isPlaneProducer(spec: ApplyFeatureEditSpec, i: number): boolean {
  return Number.isInteger(i) && i >= 0 && i < spec.producers.length
    && spec.producers[i].featureType === 'plane';
}

/**
 * Producer feature types whose source line must hold exactly that call —
 * sketch and plane inputs are referenced by identity, so any other callee at
 * the line means the file is out of sync. Null falls back to the general
 * `PRODUCER_CALLEES` allowlist.
 */
function requiredChainRoot(featureType: string): 'sketch' | 'plane' | null {
  if (featureType === 'sketch') {
    return 'sketch';
  }
  if (featureType === 'plane') {
    return 'plane';
  }
  return null;
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

/** The `.thin(…)` / `.remove()` / `.new()` chains shared by sweep and loft. */
function renderOpChains(opts: {
  op: 'add' | 'remove' | 'new';
  thin: [number] | [number, number] | null;
}): string {
  let chains = '';
  if (opts.thin) {
    chains += `.thin(${opts.thin.map(formatNumber).join(', ')})`;
  }
  if (opts.op === 'remove') {
    chains += '.remove()';
  } else if (opts.op === 'new') {
    chains += '.new()';
  }
  return chains;
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
  return `sweep(${args.join(', ')})` + renderOpChains(sw);
}

/**
 * Render a loft statement from its ordered profile expressions: `loft(s, s2)`
 * plus `.guides(g)`, `.startCondition('normal')` / `.endCondition('tangent',
 * 2)` (the default magnitude 1 is omitted), and the `.thin(…)` / `.remove()`
 * / `.new()` chains. Shared with the route's preview so the previewed text is
 * exactly what the transform writes.
 */
export function renderLoftStatement(
  lo: Pick<LoftEditOptions, 'op' | 'thin' | 'startCondition' | 'endCondition'>,
  profileExprs: string[],
  guideExprs: string[] = [],
): string {
  let statement = `loft(${profileExprs.join(', ')})`;
  if (guideExprs.length > 0) {
    statement += `.guides(${guideExprs.join(', ')})`;
  }
  statement += renderConditionChain('startCondition', lo.startCondition);
  statement += renderConditionChain('endCondition', lo.endCondition);
  return statement + renderOpChains(lo);
}

function renderConditionChain(method: string, condition: LoftConditionSpec | undefined): string {
  if (!condition) {
    return '';
  }
  const magnitude = condition.magnitude === 1 ? '' : `, ${formatNumber(condition.magnitude)}`;
  return `.${method}('${condition.type}'${magnitude})`;
}

/**
 * Render one selector part as an expression: `select(<args>)` for a global
 * part, `<var>.<accessor>(<args>)` on a bound producer. Shared with the
 * route, which renders loft profiles part-by-part with the namer's names.
 */
export function renderSelectorPartExpr(
  part: ApplyFeatureEditSpec['parts'][number],
  producerVar: string | null,
): string {
  const selectorArgs = part.indices ? part.indices.join(', ') : (part.filterArgs ?? '');
  if (part.producer === null) {
    return `select(${selectorArgs})`;
  }
  return `${producerVar}.${part.accessor}(${selectorArgs})`;
}

/**
 * Render an extrude statement from its options: `extrude(25)` / `cut()`
 * (through-all) / `extrude(10, 20)` (two distances) / `extrude(25, s)` for a
 * bound profile, plus `.symmetric()` / `.draft(…)` / `.drill(false)` /
 * `.thin(…)` / `.new()` chains. Shared with the route's preview so the
 * previewed text is exactly what the transform writes.
 */
export function renderExtrudeStatement(ext: ExtrudeEditOptions, profileVar: string | null): string {
  const callee = ext.op === 'remove' ? 'cut' : 'extrude';
  const callArgs: string[] = [];
  if (ext.distance !== null) {
    callArgs.push(formatNumber(ext.distance));
    if (ext.distance2 !== null) {
      callArgs.push(formatNumber(ext.distance2));
    }
  }
  if (ext.profile === 'bound') {
    callArgs.push(profileVar ?? 's');
  }
  let statement = `${callee}(${callArgs.join(', ')})`;
  if (ext.symmetric) {
    statement += '.symmetric()';
  }
  if (ext.draft !== null) {
    statement += `.draft(${formatNumber(ext.draft)})`;
  }
  if (!ext.drill) {
    // True is the API default, so only the opt-out is written.
    statement += '.drill(false)';
  }
  if (ext.thin) {
    statement += `.thin(${ext.thin.map(formatNumber).join(', ')})`;
  }
  if (ext.op === 'new') {
    statement += '.new()';
  }
  return statement;
}

/**
 * Render a plane statement from its rendered base expressions:
 * `plane('xy')` / `plane('xy', 10)` (offset only keeps the bare-number
 * shorthand) / `plane(e.endFaces(), { offset: 10, rotateX: 15 })` /
 * `plane(p, 'xz', { rotateY: 30 })` (mid). Shared with the route's preview so
 * the previewed text is exactly what the transform writes.
 */
export function renderPlaneStatement(pl: PlaneEditOptions, baseExprs: string[]): string {
  if (pl.type === 'edge') {
    // The second argument is the normalized position, not an offset — the
    // edge form takes no transform options.
    return `plane(${baseExprs[0]}, ${formatNumber(pl.position ?? 0)})`;
  }
  const entries: string[] = [];
  if (pl.offset !== null && pl.offset !== 0) {
    entries.push(`offset: ${formatNumber(pl.offset)}`);
  }
  const rotations: [string, number | null][] = [
    ['rotateX', pl.rotateX], ['rotateY', pl.rotateY], ['rotateZ', pl.rotateZ],
  ];
  let hasRotation = false;
  for (const [key, value] of rotations) {
    if (value !== null && value !== 0) {
      hasRotation = true;
      entries.push(`${key}: ${formatNumber(value)}`);
    }
  }
  let optionsArg = '';
  if (entries.length > 0) {
    optionsArg = !hasRotation && pl.type === 'offset'
      ? `, ${formatNumber(pl.offset!)}`
      : `, { ${entries.join(', ')} }`;
  }
  return `plane(${baseExprs.join(', ')}${optionsArg})`;
}

/**
 * Render each plane base as an expression: `'xy'` for a standard plane, the
 * bound variable for an existing plane feature, or the selector part for a
 * picked face/edge. A mid plane needs plane-like arguments, so a raw selector
 * is wrapped in its own `plane(…)` there. Shared with the route, which passes
 * its namer's variables; the transform passes its bindings'.
 */
export function renderPlaneBaseExprs(
  pl: PlaneEditOptions,
  parts: ApplyFeatureEditSpec['parts'],
  varFor: (producer: number) => string | null,
): string[] {
  return pl.bases.map(base => {
    if (base.kind === 'standard') {
      return `'${base.plane}'`;
    }
    if (base.kind === 'plane') {
      return varFor(base.producer) ?? 'p';
    }
    const part = parts[base.part];
    const expr = renderSelectorPartExpr(part, part.producer === null ? null : varFor(part.producer));
    return pl.type === 'mid' ? `plane(${expr})` : expr;
  });
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
  if (spec.feature === 'loft') {
    const lo = spec.loft!;
    const profileExprs = lo.profiles.map(profile => {
      if (profile.kind === 'sketch') {
        return bindings[profile.producer].varName!;
      }
      const part = spec.parts[profile.part];
      return renderSelectorPartExpr(part, part.producer === null ? null : bindings[part.producer].varName);
    });
    const guideExprs = (lo.guides ?? []).map(guide => bindings[guide.producer].varName!);
    return renderLoftStatement(lo, profileExprs, guideExprs);
  }
  if (spec.feature === 'plane') {
    const pl = spec.plane!;
    return renderPlaneStatement(
      pl, renderPlaneBaseExprs(pl, spec.parts, i => bindings[i].varName),
    );
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
  return rawArgs ?? spec.parts
    .map(part => renderSelectorPartExpr(part, part.producer === null ? null : bindings[part.producer].varName))
    .join(', ');
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
 * sketch variables insert directly after the latest input — a later active
 * sketch stays the active one (bound-profile extrude; bound-profile sweep
 * with a sketch path; all-sketch loft). Everything else inserts at end of
 * scope: a selector must resolve on the final model, and an implicit profile
 * must consume the scope's last sketch.
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
  if (spec.feature === 'plane') {
    // Selector-free bases are explicit plane variables (standard-only specs
    // never reach here — they append at top level with no producers at all):
    // insert right after the latest input statement.
    const planeBases = spec.plane!.bases
      .filter((b): b is { kind: 'plane'; producer: number } => b.kind === 'plane');
    if (planeBases.length > 0 && spec.plane!.bases.every(b => b.kind !== 'selector')) {
      const latest = planeBases
        .map(b => bindings[b.producer].statement)
        .reduce((a, b) => (b.endIndex >= a.endIndex ? b : a));
      return afterStatementInsertion(latest, lines);
    }
  }
  if (spec.feature === 'loft') {
    const sketches = spec.loft!.profiles
      .filter((p): p is { kind: 'sketch'; producer: number } => p.kind === 'sketch');
    if (sketches.length === spec.loft!.profiles.length) {
      // Guides are inputs too — the statement references their variables, so
      // it must land after the latest of profiles AND guides.
      const latest = [...sketches, ...(spec.loft!.guides ?? [])]
        .map(p => bindings[p.producer].statement)
        .reduce((a, b) => (b.endIndex >= a.endIndex ? b : a));
      return afterStatementInsertion(latest, lines);
    }
  }
  return findInsertionPoint(scope, lines, bindings);
}

// ---------------------------------------------------------------------------
// In-place statement editing (timeline double-click → edit dialog)
// ---------------------------------------------------------------------------

/** Feature kinds whose statements the edit dialogs can rewrite in place. */
export type EditableFeatureKind = 'extrude' | 'sweep' | 'loft' | 'shell' | 'fillet' | 'chamfer';

/**
 * An existing statement's dialog-editable reading. Argument expressions the
 * dialogs don't edit (profiles, paths, selector args) are carried as
 * verbatim source text and re-emitted unchanged; numeric options must be
 * plain literals — a variable distance is edited through the params panel,
 * not this dialog.
 */
export type ParsedFeatureStatement =
  | {
    feature: 'extrude';
    op: 'add' | 'remove' | 'new';
    /** null = through-all remove (`cut()` with no distance). */
    distance: number | null;
    /** Second distance of a two-distance `extrude(d1, d2)`, or null. */
    distance2: number | null;
    symmetric: boolean;
    /** `.draft(angle)` taper in degrees, or null when the chain is absent. */
    draft: number | null;
    drill: boolean;
    thin: [number] | null;
    /** Trailing profile argument text (`s`), or null for implicit consumption. */
    profileText: string | null;
  }
  | {
    feature: 'sweep';
    op: 'add' | 'remove' | 'new';
    thin: [number] | null;
    pathText: string;
    profileText: string | null;
  }
  | {
    feature: 'loft';
    op: 'add' | 'remove' | 'new';
    thin: [number] | null;
    profileTexts: string[];
    guideTexts: string[];
    startCondition: LoftConditionSpec | null;
    endCondition: LoftConditionSpec | null;
  }
  | {
    feature: 'shell' | 'fillet' | 'chamfer';
    value: number;
    /** Selector argument list after the value, verbatim (`''` when absent). */
    argsText: string;
  };

const EDITABLE_CALLEES: Record<string, EditableFeatureKind> = {
  extrude: 'extrude',
  cut: 'extrude',
  sweep: 'sweep',
  loft: 'loft',
  shell: 'shell',
  fillet: 'fillet',
  chamfer: 'chamfer',
};

/**
 * Chain members the dialogs edit, per feature. They must form a prefix of
 * the member chain: anything after the first unrecognized member (a chained
 * `.fillet()`, `.color()` …) is preserved verbatim, but a recognized member
 * hiding *behind* an unrecognized one would leave the dialog lying about the
 * statement, so that shape refuses to parse.
 */
const OPTION_MEMBERS: Record<EditableFeatureKind, Set<string>> = {
  extrude: new Set(['symmetric', 'draft', 'drill', 'thin', 'remove', 'new']),
  sweep: new Set(['thin', 'remove', 'new']),
  loft: new Set(['guides', 'startCondition', 'endCondition', 'thin', 'remove', 'new']),
  shell: new Set(),
  fillet: new Set(),
  chamfer: new Set(),
};

type ChainSegment = { name: string; args: TSNode[]; endIndex: number };

/** Split a call chain into its root call and member calls, in source order. */
function decomposeChain(call: TSNode): { root: ChainSegment; members: ChainSegment[] } | null {
  const segments: ChainSegment[] = [];
  let current: TSNode | null = call;
  while (current && current.type === 'call_expression') {
    const argsNode = current.childForFieldName('arguments');
    const args = argsNode ? argsNode.namedChildren.filter(a => a.type !== 'comment') : [];
    const fn = current.childForFieldName('function');
    if (!fn) {
      return null;
    }
    if (fn.type === 'identifier') {
      segments.push({ name: fn.text, args, endIndex: current.endIndex });
      segments.reverse();
      const [root, ...members] = segments;
      return { root, members };
    }
    if (fn.type === 'member_expression') {
      const prop = fn.childForFieldName('property');
      if (!prop) {
        return null;
      }
      segments.push({ name: prop.text, args, endIndex: current.endIndex });
      current = fn.childForFieldName('object');
      continue;
    }
    return null;
  }
  return null;
}

/** Numeric literal value of an argument node, or null when it is anything else. */
function numericArgValue(node: TSNode): number | null {
  const text = numericLiteralText(node);
  if (text === null) {
    return null;
  }
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/** Boolean literal value of an argument node, or null when it is anything else. */
function booleanArgValue(node: TSNode): boolean | null {
  if (node.type === 'true') {
    return true;
  }
  if (node.type === 'false') {
    return false;
  }
  return null;
}

type ChainParse =
  | { parsed: ParsedFeatureStatement; start: number; end: number }
  | { error: string };

/**
 * Read the feature chain rooted at `call` into its dialog-editable options.
 * `start`/`end` span the chain root through its last recognized option
 * member — the range an edit replaces; a `const x = ` binding before it and
 * unrecognized chained calls after it survive untouched.
 */
function parseFeatureChain(call: TSNode, code: string): ChainParse {
  const chain = decomposeChain(call);
  if (!chain) {
    return { error: 'the call at that line is not a plain feature call chain' };
  }
  const feature = EDITABLE_CALLEES[chain.root.name];
  if (!feature) {
    return { error: `${chain.root.name}() is not an editable feature statement` };
  }

  const options = OPTION_MEMBERS[feature];
  const recognized = new Map<string, ChainSegment>();
  let end = chain.root.endIndex;
  let stopped = false;
  for (const member of chain.members) {
    if (!stopped && options.has(member.name)) {
      if (recognized.has(member.name)) {
        return { error: `the statement chains .${member.name}() twice` };
      }
      recognized.set(member.name, member);
      end = member.endIndex;
      continue;
    }
    stopped = true;
    if (options.has(member.name)) {
      return { error: `a .${member.name}() chain follows other calls the dialog cannot edit — edit the statement in the source instead` };
    }
  }
  const start = call.startIndex;
  const args = chain.root.args;

  if (feature === 'shell' || feature === 'fillet' || feature === 'chamfer') {
    if (args.length === 0) {
      return { error: `the ${feature}() call has no arguments` };
    }
    const value = numericArgValue(args[0]);
    if (value === null) {
      return { error: `the ${feature}() ${feature === 'shell' ? 'thickness' : feature === 'fillet' ? 'radius' : 'distance'} is not a plain number — edit it in the source` };
    }
    const argsText = args.length > 1
      ? code.slice(args[1].startIndex, args[args.length - 1].endIndex)
      : '';
    return { parsed: { feature, value, argsText }, start, end };
  }

  const isCut = chain.root.name === 'cut';
  const hasRemove = recognized.has('remove');
  const hasNew = recognized.has('new');
  if ((isCut || hasRemove) && hasNew) {
    return { error: 'the statement chains both a remove and .new()' };
  }
  const op: 'add' | 'remove' | 'new' = isCut || hasRemove ? 'remove' : hasNew ? 'new' : 'add';

  let thin: [number] | null = null;
  const thinSeg = recognized.get('thin');
  if (thinSeg) {
    if (thinSeg.args.length !== 1) {
      return { error: 'only a single-offset .thin() can be edited in the dialog' };
    }
    const offset = numericArgValue(thinSeg.args[0]);
    if (offset === null) {
      return { error: 'the .thin() offset is not a plain number — edit it in the source' };
    }
    thin = [offset];
  }

  if (feature === 'extrude') {
    // Leading numeric literals are distances — one, or two for the
    // two-distance form extrude(d1, d2); a single trailing non-numeric
    // argument is the bound profile expression, kept verbatim. A cut()
    // with no distance is the through-all remove.
    const distances: number[] = [];
    while (distances.length < Math.min(args.length, 2)) {
      const value = numericArgValue(args[distances.length]);
      if (value === null) {
        break;
      }
      distances.push(value);
    }
    const rest = args.slice(distances.length);
    if (rest.length > 1 || (rest.length === 1 && numericArgValue(rest[0]) !== null)) {
      return { error: 'the extrude has more arguments than the dialog understands' };
    }
    const profileText = rest.length === 1 ? rest[0].text : null;
    const distance = distances[0] ?? null;
    const distance2 = distances[1] ?? null;
    if (distance === null && !isCut) {
      // extrude(x) is ambiguous between a variable distance and a bound
      // profile at the default distance — neither is dialog-editable.
      return {
        error: profileText !== null
          ? `the ${chain.root.name}() distance is not a plain number — edit it in the source`
          : 'an extrude with no distance is not editable in the dialog',
      };
    }

    const symmetricSeg = recognized.get('symmetric');
    if (symmetricSeg && symmetricSeg.args.length > 0) {
      return { error: 'the .symmetric() chain has arguments the dialog cannot edit' };
    }
    const symmetric = symmetricSeg !== undefined;
    if (symmetric && distance2 !== null) {
      return { error: `a two-distance ${chain.root.name}() cannot chain .symmetric() — edit it in the source` };
    }

    let draft: number | null = null;
    const draftSeg = recognized.get('draft');
    if (draftSeg) {
      if (draftSeg.args.length !== 1) {
        return { error: 'the .draft() chain has an argument shape the dialog cannot edit' };
      }
      draft = numericArgValue(draftSeg.args[0]);
      if (draft === null) {
        // Also covers the [start, end] per-side form the dialog doesn't offer.
        return { error: 'the .draft() angle is not a plain number — edit it in the source' };
      }
    }

    let drill = true;
    const drillSeg = recognized.get('drill');
    if (drillSeg) {
      if (drillSeg.args.length > 1) {
        return { error: 'the .drill() chain has more arguments than the dialog understands' };
      }
      if (drillSeg.args.length === 1) {
        const value = booleanArgValue(drillSeg.args[0]);
        if (value === null) {
          return { error: 'the .drill() argument is not a plain boolean — edit it in the source' };
        }
        drill = value;
      }
      // A bare .drill() means true — the API default.
    }

    return { parsed: { feature, op, distance, distance2, symmetric, draft, drill, thin, profileText }, start, end };
  }

  if (feature === 'sweep') {
    if (args.length < 1 || args.length > 2) {
      return { error: 'the sweep has more arguments than the dialog understands' };
    }
    return {
      parsed: { feature, op, thin, pathText: args[0].text, profileText: args[1]?.text ?? null },
      start,
      end,
    };
  }

  // Loft: every root argument is a profile expression, in order.
  if (args.length < 2) {
    return { error: 'the loft has fewer than two profiles' };
  }
  const guideSeg = recognized.get('guides');
  if (guideSeg && (guideSeg.args.length < 1 || guideSeg.args.length > 2)) {
    return { error: 'the .guides() chain must carry one or two guides' };
  }
  const startParse = parseConditionSegment(recognized.get('startCondition'));
  if ('error' in startParse) {
    return startParse;
  }
  const endParse = parseConditionSegment(recognized.get('endCondition'));
  if ('error' in endParse) {
    return endParse;
  }
  return {
    parsed: {
      feature: 'loft',
      op,
      thin,
      profileTexts: args.map(a => a.text),
      guideTexts: guideSeg ? guideSeg.args.map(a => a.text) : [],
      startCondition: startParse.condition,
      endCondition: endParse.condition,
    },
    start,
    end,
  };
}

/**
 * One `.startCondition(…)`/`.endCondition(…)` member: a plain 'normal' /
 * 'tangent' string plus an optional numeric magnitude (default 1). A 'none'
 * argument reads as no condition — the API's 'none' merely clears one.
 */
function parseConditionSegment(
  seg: ChainSegment | undefined,
): { condition: LoftConditionSpec | null } | { error: string } {
  if (!seg) {
    return { condition: null };
  }
  if (seg.args.length < 1 || seg.args.length > 2) {
    return { error: `the .${seg.name}() chain has an argument shape the dialog cannot edit` };
  }
  const typeNode = seg.args[0];
  if (typeNode.type !== 'string') {
    return { error: `the .${seg.name}() type is not a plain string — edit it in the source` };
  }
  const type = typeNode.text.slice(1, -1);
  if (type === 'none') {
    return { condition: null };
  }
  if (type !== 'normal' && type !== 'tangent') {
    return { error: `the .${seg.name}() type '${type}' is not one the dialog knows` };
  }
  let magnitude = 1;
  if (seg.args.length === 2) {
    const parsed = numericArgValue(seg.args[1]);
    if (parsed === null || parsed === 0) {
      return { error: `the .${seg.name}() magnitude is not a plain nonzero number — edit it in the source` };
    }
    magnitude = parsed;
  }
  return { condition: { type, magnitude } };
}

/**
 * Read the feature statement at `line` of `code` into its dialog-editable
 * options — the read half of the double-click → edit-dialog round trip.
 * `statement` is the chain text the dialog would rewrite, for display.
 */
export async function parseFeatureStatement(
  code: string,
  line: number,
): Promise<{ ok: true; parsed: ParsedFeatureStatement; statement: string } | { ok: false; reason: string }> {
  const parser = await getJavaScriptParser();
  const tree = parser.parse(code);
  const lines = splitLines(code);
  const call = findEditableCallAt(tree, lines, line);
  if (!call) {
    return { ok: false, reason: `no call found at line ${line} — is the file in sync with the last render?` };
  }
  const chain = parseFeatureChain(call, code);
  if ('error' in chain) {
    return { ok: false, reason: chain.error };
  }
  return { ok: true, parsed: chain.parsed, statement: code.slice(chain.start, chain.end) };
}

function validEditOp(op: unknown): op is 'add' | 'remove' | 'new' {
  return op === 'add' || op === 'remove' || op === 'new';
}

function validEditThin(thin: unknown): thin is [number] | [number, number] | null {
  if (thin === null) {
    return true;
  }
  return Array.isArray(thin) && thin.length >= 1 && thin.length <= 2
    && thin.every(t => typeof t === 'number' && Number.isFinite(t) && t > 0);
}

function validEditCondition(condition: LoftConditionSpec | undefined): boolean {
  return condition === undefined
    || ((condition.type === 'normal' || condition.type === 'tangent')
      && Number.isFinite(condition.magnitude) && condition.magnitude !== 0);
}

function validNonzeroOrNull(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value) && value !== 0);
}

/**
 * Render the statement `spec`'s dialog options produce over the parsed
 * statement, keeping the expressions the dialog doesn't edit verbatim.
 * Shared with the route's preview so the previewed text is exactly what the
 * transform writes.
 */
export function renderEditedStatement(
  parsed: ParsedFeatureStatement,
  spec: Pick<ApplyFeatureEditSpec, 'feature' | 'value' | 'rawArgs' | 'edit'>,
): { statement: string } | { error: string } {
  if (spec.feature !== parsed.feature) {
    return {
      error: `the statement is a ${parsed.feature}, not a ${spec.feature} — `
        + 'is the file in sync with the last render?',
    };
  }
  if (parsed.feature === 'extrude') {
    const opts = spec.edit?.extrude;
    if (!opts || !validEditOp(opts.op) || !validEditThin(opts.thin)
      || !validNonzeroOrNull(opts.distance2) || !validNonzeroOrNull(opts.draft)
      || typeof opts.symmetric !== 'boolean' || typeof opts.drill !== 'boolean') {
      return { error: 'malformed extrude edit spec' };
    }
    if (opts.distance === null) {
      if (opts.op !== 'remove') {
        return { error: 'distance may be null (through-all) only for a remove' };
      }
      if (opts.distance2 !== null) {
        return { error: 'a two-distance extrude cannot be through-all' };
      }
    } else if (typeof opts.distance !== 'number' || !Number.isFinite(opts.distance) || opts.distance === 0) {
      return { error: 'malformed extrude edit spec' };
    }
    if (opts.distance2 !== null && opts.symmetric) {
      return { error: 'a two-distance extrude cannot be symmetric' };
    }
    return {
      statement: renderExtrudeStatement(
        { ...opts, profile: parsed.profileText ? 'bound' : 'implicit' },
        parsed.profileText,
      ),
    };
  }
  if (parsed.feature === 'sweep') {
    const opts = spec.edit?.sweep;
    if (!opts || !validEditOp(opts.op) || !validEditThin(opts.thin)) {
      return { error: 'malformed sweep edit spec' };
    }
    return {
      statement: renderSweepStatement({ op: opts.op, thin: opts.thin }, parsed.pathText, parsed.profileText),
    };
  }
  if (parsed.feature === 'loft') {
    const opts = spec.edit?.loft;
    if (!opts || !validEditOp(opts.op) || !validEditThin(opts.thin)
      || !validEditCondition(opts.startCondition) || !validEditCondition(opts.endCondition)) {
      return { error: 'malformed loft edit spec' };
    }
    if (parsed.guideTexts.length > 0 && opts.thin) {
      return { error: 'loft guides cannot be combined with thin walls' };
    }
    return {
      statement: renderLoftStatement(
        { op: opts.op, thin: opts.thin, startCondition: opts.startCondition, endCondition: opts.endCondition },
        parsed.profileTexts,
        parsed.guideTexts,
      ),
    };
  }
  if (typeof spec.value !== 'number' || !Number.isFinite(spec.value) || spec.value === 0) {
    return { error: `the ${parsed.feature} value must be a nonzero number` };
  }
  const args = spec.rawArgs?.trim() || parsed.argsText;
  return {
    statement: args
      ? `${parsed.feature}(${formatNumber(spec.value)}, ${args})`
      : `${parsed.feature}(${formatNumber(spec.value)})`,
  };
}

/**
 * Rewrite the feature statement at `spec.edit.line` in place: re-parse the
 * chain from the live source (nothing captured at dialog-open time can go
 * stale), apply the dialog's options over it, and splice the rendered chain
 * over the old one. A `const x = ` binding and any chained calls after the
 * recognized options survive untouched.
 */
async function applyStatementEdit(code: string, spec: ApplyFeatureEditSpec): Promise<ApplyFeatureEditResult> {
  const edit = spec.edit!;
  if (!Number.isInteger(edit.line) || edit.line < 1) {
    return { newCode: code, error: 'malformed edit spec: bad line' };
  }
  const parser = await getJavaScriptParser();
  const tree = parser.parse(code);
  const lines = splitLines(code);
  const call = findEditableCallAt(tree, lines, edit.line);
  if (!call) {
    return { newCode: code, error: `no call found at line ${edit.line} — is the file in sync with the last render?` };
  }
  const chain = parseFeatureChain(call, code);
  if ('error' in chain) {
    return { newCode: code, error: chain.error };
  }
  if (chain.parsed.feature !== spec.feature) {
    return {
      newCode: code,
      error: `the statement at line ${edit.line} is a ${chain.parsed.feature}, `
        + `expected a ${spec.feature} — is the file in sync with the last render?`,
    };
  }
  const rendered = renderEditedStatement(chain.parsed, spec);
  if ('error' in rendered) {
    return { newCode: code, error: rendered.error };
  }

  let result = spliceCode(code, chain.start, chain.end, rendered.statement);
  const callee = spec.feature === 'extrude'
    ? (edit.extrude!.op === 'remove' ? 'cut' : 'extrude')
    : spec.feature;
  result = await ensureSymbolImport(result, callee);
  if (spec.rawArgs?.trim()) {
    for (const symbol of importsForRawArgs(spec.rawArgs)) {
      result = await ensureSymbolImport(result, symbol, MODULE_FOR_IMPORT[symbol] ?? 'fluidcad/core');
    }
  }
  return { newCode: result };
}

/**
 * End-of-scope insertion point: after the scope's last statement, but before
 * a trailing `return`. Inserting at the end matches what the user saw — the
 * picked edges survived to the final model, so resolving the selection after
 * the last statement is guaranteed to find them. `indent` is the statement
 * indent at the insertion point, for statements with internal newlines.
 *
 * With an active `breakpoint();` the model the user saw is the paused one —
 * statements after the breakpoint never ran and the selection resolved
 * against the paused state — so the statement lands before the first
 * breakpoint that follows the producers, not after it.
 */
function findInsertionPoint(
  scope: TSNode,
  lines: string[],
  bindings: ProducerBinding[],
): { index: number; indent: string; wrap: (stmt: string) => string } {
  const children = scope.namedChildren;

  const latestProducerEnd = Math.max(...bindings.map(b => b.statement.endIndex));
  const breakpointStmt = children.find(c => isBreakpointStatement(c) && c.startIndex >= latestProducerEnd);
  if (breakpointStmt) {
    const indent = indentOf(lines, breakpointStmt.startPosition.row);
    return { index: breakpointStmt.startIndex, indent, wrap: (stmt) => `${stmt}\n${indent}` };
  }

  const last = children.length > 0 ? children[children.length - 1] : null;

  if (last && last.type === 'return_statement') {
    const indent = indentOf(lines, last.startPosition.row);
    return { index: last.startIndex, indent, wrap: (stmt) => `${stmt}\n${indent}` };
  }

  const anchor = last ?? bindings[0].statement;
  const indent = indentOf(lines, anchor.startPosition.row);
  return { index: anchor.endIndex, indent, wrap: (stmt) => `\n${indent}${stmt}` };
}

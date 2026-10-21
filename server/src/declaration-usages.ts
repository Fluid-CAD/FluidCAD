// Where a model reads one `param()` or `property()` declaration — in the file
// that declares it and in every file that imports that file — and the two
// rewrites of those reads a panel edit needs: following a rename, and
// standing in the declaration's value when the declaration goes.
//
// A declaration is read five ways. Its bound variable is read in its own
// file, and — exported from the top level — through an `import { … }` in
// another. A `param()` is also addressed by label from the outside:
// `insert(def, { Label: value })` overrides it per instance, and from its
// own body's `configurations({ Row: { Label: value } })` table, whose cells
// set it per configuration. A `property()` is read by name off the
// definition (`def.properties.name`) or off an inserted instance
// (`inst.properties.name`), in either file. All five are
// found statically, by resolving the identifier each read hangs off to the
// declaring file's exported definition or variable — so the same routine
// serves a file the server holds and the live buffer the editor host hands
// back through the apply-feature round trip.
//
// The bindings a rename of their own follows are read the same way, and
// renamed through the same routine. A part's `const` is read through the
// imports of its export. An instance an assembly returns among its parts is
// read by name off an occurrence of the assembly (`occ.parts.name`), or
// through an import when its binding is exported from the top level.

import {
  applySpliceEdits,
  getJavaScriptParser,
  LexicalBindings,
  RenderedProperties,
  spliceCode,
  splitLines,
  stringLiteralValue,
  walkTree,
  type Binding,
  type SpliceEdit,
  type TSNode,
  type TSTree,
} from './code-editor/index.ts';
import {
  bindingOfDeclarator,
  findBindingReferences,
  freeIdentifiers,
  inlineReferenceEdits,
  isAtomicExpression,
  readsSameBindings,
  renameReferenceEdits,
  expressionInPlaceOf,
  type BindingReference,
  type FreeIdentifier,
} from './code-editor/binding-references.ts';
import {
  boundVariable,
  declaresName,
  findDeclarationCalls,
  isSameNode,
  outermostExpression,
  type DeclarationCall,
} from './code-editor/declaration-calls.ts';
import { renderKey } from './part-catalog/insert-edit.ts';
import { normalizePath } from './normalize-path.ts';
import { ModuleSpecifiers } from './files/module-specifiers.ts';

export type DeclarationKind = 'param' | 'property';

/**
 * What any file needs to find the reads of one declaration: which file
 * declares it, the key it is addressed by from outside (a param's label, a
 * property's name, the name an assembly returns an instance under), the
 * variable it binds and the name that variable is exported under, and the
 * `part()` or `assembly()` definition whose body holds it — by its local
 * binding and its export name, which is what an `insert()`, a `.properties`
 * or a `.parts` read in another file resolves to.
 */
export type DeclarationRef = {
  kind: DeclarationKind | 'part' | 'instance';
  key: string;
  /** Absolute path of the declaring file. */
  filePath: string;
  /** Null as well for a part or an instance: its own file follows the binding itself, from the declarator it holds. */
  variable: string | null;
  /** The name `variable` is exported under from the file's top level, or null when it is not. */
  variableExport: string | null;
  definition: { localName: string | null; exportName: string | null } | null;
};

/**
 * A rewrite of the reads one file makes of a declaration. `rename` follows
 * a new key and variable; `inline` replaces every read by `expression` and
 * drops every `insert()` override. `portable` says whether the expression
 * reads nothing but globals — the only case a read in ANOTHER file can take
 * it; the declaring file decides per read, from its own scopes.
 */
export type UsageEditSpec =
  | {
    action: 'rename';
    declaration: DeclarationRef;
    newKey: string;
    newVariable: string | null;
    newVariableExport: string | null;
  }
  | {
    action: 'inline';
    declaration: DeclarationRef;
    expression: string;
    portable: boolean;
  };

/** One read of a declaration, as found in a file. */
export type UsageSite =
  | { kind: 'variable'; reference: BindingReference }
  | { kind: 'import'; specifier: TSNode; localName: string; references: BindingReference[] }
  | { kind: 'override'; call: TSNode; object: TSNode; entry: TSNode }
  | { kind: 'configuration'; call: TSNode; row: TSNode; object: TSNode; entry: TSNode }
  | { kind: 'read'; member: TSNode; property: TSNode };

type OverrideSite = Extract<UsageSite, { kind: 'override' }>;
type ConfigurationSite = Extract<UsageSite, { kind: 'configuration' }>;

/** The sites a delete drops rather than replaces: an override entry, a configuration cell. */
export function isDroppedSite(site: UsageSite): boolean {
  return site.kind === 'override' || site.kind === 'configuration';
}
type ImportSite = Extract<UsageSite, { kind: 'import' }>;

/** 1-indexed line of a usage site, for reporting. */
export function usageLine(site: UsageSite): number {
  switch (site.kind) {
    case 'variable':
      return site.reference.node.startPosition.row + 1;
    case 'import':
      return site.specifier.startPosition.row + 1;
    case 'override':
    case 'configuration':
      return site.entry.startPosition.row + 1;
    case 'read':
      return site.member.startPosition.row + 1;
  }
}

/** How much of one file reads a declaration: the count and the first few 1-indexed lines. */
export type UsageFileSummary = { filePath: string; count: number; lines: number[] };

/** What deleting a declaration does to the model, by file. */
export type DeletionPlan = {
  /** The source text that stands in for every read, or null when the declaration has no value to inline. */
  value: string | null;
  /** Reads the value replaces. */
  replaced: UsageFileSummary[];
  /** `insert()` overrides that are dropped — the instance falls back to the default. */
  dropped: UsageFileSummary[];
  /** `configurations()` cells that are dropped — the row falls back to the default. */
  configurations: UsageFileSummary[];
  /** Reads the value cannot replace; the delete is refused while any remain. */
  blocked: UsageFileSummary[];
};

/** Lines shown per file before the summary says "…". */
const SUMMARY_LINES = 5;

/**
 * The reads one site stands for, as 1-indexed lines. An import specifier
 * stands for the reads of the name it binds — those are what a rename
 * follows and a delete replaces — and for itself alone when the file
 * imports the name without reading it.
 */
function usageLines(site: UsageSite): number[] {
  if (site.kind === 'import' && site.references.length > 0) {
    return site.references.map((reference) => reference.node.startPosition.row + 1);
  }
  return [usageLine(site)];
}

/**
 * Summarize `sites` for one file — null when there are none. An importing
 * file counts the reads of what it imports, not the specifier that brings
 * it in (see {@link usageLines}).
 */
export function summarizeSites(filePath: string, sites: UsageSite[]): UsageFileSummary | null {
  if (sites.length === 0) {
    return null;
  }
  const all = sites.flatMap(usageLines);
  const lines = [...new Set(all)].sort((a, b) => a - b);
  return { filePath, count: all.length, lines: lines.slice(0, SUMMARY_LINES) };
}

/**
 * What the declaring file knows about deleting or renaming a declaration:
 * how the rest of the model addresses it, the value that would replace its
 * reads, whether that value can leave the file, and the file's own reads —
 * the ones the value cannot replace called out.
 */
export type DeclarationPlan = {
  declaration: DeclarationRef;
  value: string | null;
  portable: boolean;
  sites: UsageSite[];
  blocked: UsageSite[];
  usages: DeclarationUsages;
};

/**
 * The part of a panel's usage answer both declaration kinds share: how the
 * model addresses the declaration, the value that replaces its reads, and
 * the per-file breakdown of a delete. The declaring file fills it from its
 * own {@link DeclarationPlan}; the route appends every other file's reads.
 */
export type DeclarationReport = {
  declaration?: DeclarationRef;
  value: string | null;
  portable: boolean;
  /** Every file that reads the declaration, the declaring file first. */
  usages: UsageFileSummary[];
  deletion: DeletionPlan;
};

/** A report for a declaration that could not be located: nothing reads it, nothing replaces it. */
export function emptyReport(): DeclarationReport {
  return {
    value: null, portable: false, usages: [],
    deletion: { value: null, replaced: [], dropped: [], configurations: [], blocked: [] },
  };
}

/** The reads `sites` make of a declaration in `filePath`, split the way a delete treats them. */
export function fileReport(
  filePath: string,
  sites: UsageSite[],
  blocked: UsageSite[],
): {
  usages: UsageFileSummary[];
  replaced: UsageFileSummary[];
  dropped: UsageFileSummary[];
  configurations: UsageFileSummary[];
  blocked: UsageFileSummary[];
} {
  const overrides = sites.filter((site) => site.kind === 'override');
  const cells = sites.filter((site) => site.kind === 'configuration');
  const replaced = sites.filter((site) => !isDroppedSite(site) && !blocked.includes(site));
  const summary = (subset: UsageSite[]) => {
    const one = summarizeSites(filePath, subset);
    return one ? [one] : [];
  };
  return {
    usages: summary(sites),
    replaced: summary(replaced),
    dropped: summary(overrides),
    configurations: summary(cells),
    blocked: summary(blocked),
  };
}

/** The declaring file's own {@link DeclarationReport}, from its plan. */
export function reportOf(plan: DeclarationPlan): DeclarationReport {
  const file = fileReport(plan.declaration.filePath, plan.sites, plan.blocked);
  return {
    declaration: plan.declaration,
    value: plan.value,
    portable: plan.portable,
    usages: file.usages,
    deletion: {
      value: plan.value,
      replaced: file.replaced,
      dropped: file.dropped,
      configurations: file.configurations,
      blocked: file.blocked,
    },
  };
}

/** Fold one more file's reads into a report. */
export function appendFileReport(report: DeclarationReport, file: ReturnType<typeof fileReport>): void {
  report.usages.push(...file.usages);
  report.deletion.replaced.push(...file.replaced);
  report.deletion.dropped.push(...file.dropped);
  report.deletion.configurations.push(...file.configurations);
  report.deletion.blocked.push(...file.blocked);
}

/** A file as the panel names it: its name alone, the workspace path being the panel's context. */
function displayName(filePath: string): string {
  return filePath.split('/').pop() || 'this file';
}

/** `plug.part.js (lines 8, 12), frame.assembly.js (line 20)` */
export function describeFileSummaries(summaries: UsageFileSummary[]): string {
  return summaries.map((file) => {
    const lines = file.lines.join(', ') + (file.count > file.lines.length ? ', …' : '');
    return `${displayName(file.filePath)} (line${file.lines.length === 1 && file.count === 1 ? '' : 's'} ${lines})`;
  }).join(', ');
}

/**
 * Why a delete is refused: the value reads names that mean nothing where
 * the declaration is read, so those reads have to be rewritten by hand.
 */
export function blockedReason(kind: DeclarationRef['kind'], key: string, value: string | null, blocked: UsageFileSummary[]): string {
  const noun = kind === 'param' ? 'parameter' : kind;
  const where = describeFileSummaries(blocked);
  if (value === null) {
    return `"${key}" has no value to put in place of its reads at ${where} — rewrite them by hand, then delete the ${noun}`;
  }
  return `the value of "${key}" (${value}) reads names that are out of scope at ${where} — rewrite those reads by hand, then delete the ${noun}`;
}

/** The node a usage reads at — where an inlined expression has to make sense. */
function usageNode(site: UsageSite): TSNode {
  switch (site.kind) {
    case 'variable':
      return site.reference.node;
    case 'import':
      return site.specifier;
    case 'override':
    case 'configuration':
      return site.entry;
    case 'read':
      return site.member;
  }
}

/** The declaration's value argument — a param's default, a property's value. */
export function declarationValue(declaration: DeclarationCall): TSNode | null {
  return declaration.value;
}

/**
 * Whether a module specifier written in `fromFile` reaches `target` — the
 * one rule {@link ModuleSpecifiers.reaches} keeps (a relative path, `.js`
 * optional; a pinned package's bare name). The declarations these usages
 * track live in files an edit can change, and an installed package's
 * files are read-only (K8), so the project-less {@link ModuleSpecifiers.LOCAL}
 * — workspace modules only — is the default.
 */
export function specifierReaches(
  fromFile: string,
  specifier: string,
  target: string,
  specifiers: ModuleSpecifiers = ModuleSpecifiers.LOCAL,
): boolean {
  return specifiers.reaches(fromFile, specifier, target);
}

/**
 * Describe the declaration `call` binds in `filePath`, for the reads other
 * files can make of it: the variable and its export, and the definition
 * around it. A definition counts only when bound to a module-level const —
 * `insert()` and `.properties` reads reach it through that name alone.
 */
export function describeDeclaration(
  tree: TSTree,
  filePath: string,
  kind: DeclarationKind,
  declaration: DeclarationCall,
): DeclarationRef {
  const bindings = new LexicalBindings(tree);
  const variable = declaration.variable;
  let variableExport: string | null = null;
  if (variable !== null) {
    const declarator = outermostExpression(declaration.call).parent!;
    const binding = bindingOfDeclarator(bindings, declarator.childForFieldName('name')!);
    variableExport = binding && binding.scope.type === 'program' ? exportNameOf(tree, binding) : null;
  }
  const definition = enclosingDefinition(tree, bindings, declaration.call);
  return { kind, key: declaration.key, filePath: normalizePath(filePath), variable, variableExport, definition };
}

/**
 * The `part()` or `assembly()` definition whose body holds `node`, as the
 * rest of the model names it: its module-level const and the name that
 * const is exported under. Null outside every definition; the names are
 * null for a definition no module-level const binds.
 */
export function enclosingDefinition(
  tree: TSTree,
  bindings: LexicalBindings,
  node: TSNode,
): DeclarationRef['definition'] {
  const definitionCall = enclosingDefinitionCall(node);
  if (!definitionCall) {
    return null;
  }
  const localName = boundVariable(definitionCall);
  const nameNode = localName === null ? null : outermostExpression(definitionCall).parent!.childForFieldName('name');
  const binding = nameNode ? bindingOfDeclarator(bindings, nameNode) : null;
  const moduleLevel = binding !== null && binding.scope.type === 'program';
  return {
    localName: moduleLevel ? localName : null,
    exportName: moduleLevel ? exportNameOf(tree, binding!) : null,
  };
}

/** {@link DeclarationPlan} for the declaration `call` binds in the file `tree` was parsed from. */
export function planDeclaringFile(
  tree: TSTree,
  filePath: string,
  kind: DeclarationKind,
  call: DeclarationCall,
): DeclarationPlan {
  const declaration = describeDeclaration(tree, filePath, kind, call);
  const usages = new DeclarationUsages(tree, filePath, declaration);
  const value = declarationValue(call);
  const sites = usages.sites();
  const portable = value !== null && DeclarationUsages.isPortable(new LexicalBindings(tree), value);
  const blocked = value === null ? sites.filter((site) => !isDroppedSite(site)) : usages.blockedSites(sites, value, portable);
  return { declaration, value: value?.text ?? null, portable, sites, blocked, usages };
}

/**
 * The innermost `part(…)` or `assembly(…)` call whose callback body holds
 * `node` — the definition an outside reader addresses the declaration through.
 */
function enclosingDefinitionCall(node: TSNode): TSNode | null {
  for (let current = node.parent; current; current = current.parent) {
    if (current.type !== 'call_expression') {
      continue;
    }
    const callee = current.childForFieldName('function');
    if (callee?.type === 'identifier' && (callee.text === 'part' || callee.text === 'assembly')) {
      return current;
    }
  }
  return null;
}

/**
 * The name a module-level binding is exported under: its own for
 * `export const x` and `export { x }`, the alias for `export { x as y }`,
 * null when the file keeps it to itself.
 */
export function exportNameOf(tree: TSTree, binding: Binding): string | null {
  const statement = binding.id.parent?.parent?.parent;
  if (statement?.type === 'export_statement') {
    return binding.name;
  }
  for (const node of walkTree(tree.rootNode)) {
    if (node.type !== 'export_specifier') {
      continue;
    }
    const name = node.childForFieldName('name');
    if (name?.text === binding.name && node.parent?.parent?.type === 'export_statement') {
      return node.childForFieldName('alias')?.text ?? binding.name;
    }
  }
  return null;
}

/** The label or name an object-literal entry is keyed by, or null for a computed key. */
export function entryKey(entry: TSNode): string | null {
  if (entry.type === 'shorthand_property_identifier') {
    return entry.text;
  }
  if (entry.type !== 'pair') {
    return null;
  }
  const key = entry.childForFieldName('key');
  if (!key) {
    return null;
  }
  return key.type === 'property_identifier' ? key.text : stringLiteralValue(key);
}

/** The identifier a member or call chain hangs off: `inst` in `inst.instance(2).properties.x`. */
function chainRootIdentifier(node: TSNode): TSNode | null {
  let current: TSNode | null = node;
  while (current) {
    switch (current.type) {
      case 'identifier':
        return current;
      case 'member_expression':
      case 'subscript_expression':
        current = current.childForFieldName('object');
        break;
      case 'call_expression':
        current = current.childForFieldName('function');
        break;
      case 'parenthesized_expression':
        current = current.namedChild(0);
        break;
      default:
        return null;
    }
  }
  return null;
}

/** The member a declaration is read by name off, for the kinds that are read that way. */
const READ_ACCESSORS: Partial<Record<DeclarationRef['kind'], string>> = { property: 'properties', instance: 'parts' };

/**
 * The reads one file makes of a declaration. `filePath` is the file the
 * code belongs to: the declaring file reads the variable directly and the
 * definition by its local name; any other file reads both through imports
 * that resolve to the declaring file.
 */
export class DeclarationUsages {
  private readonly bindings: LexicalBindings;
  private readonly sameFile: boolean;

  constructor(
    readonly tree: TSTree,
    readonly filePath: string,
    readonly declaration: DeclarationRef,
  ) {
    this.bindings = new LexicalBindings(tree);
    this.sameFile = normalizePath(filePath) === declaration.filePath;
  }

  static async of(code: string, filePath: string, declaration: DeclarationRef): Promise<DeclarationUsages> {
    const parser = await getJavaScriptParser();
    return new DeclarationUsages(parser.parse(code), filePath, declaration);
  }

  /** Every read, in no particular order. */
  sites(): UsageSite[] {
    return [...this.variableSites(), ...this.overrideSites(), ...this.configurationSites(), ...this.readSites()];
  }

  /**
   * Reads of the bound variable: in the declaring file, of the declaration's
   * own binding; elsewhere, of each `import { <export> }` specifier that
   * brings it in, the specifier included.
   */
  private variableSites(): UsageSite[] {
    const { variable, variableExport } = this.declaration;
    if (this.sameFile) {
      const binding = variable === null ? null : this.declaringBinding(variable);
      return binding
        ? findBindingReferences(this.bindings, binding).map((reference) => ({ kind: 'variable', reference }))
        : [];
    }
    if (variableExport === null) {
      return [];
    }
    const sites: UsageSite[] = [];
    for (const binding of this.importsOfDeclaringFile()) {
      if (binding.imported!.name === variableExport) {
        sites.push({
          kind: 'import',
          specifier: binding.id.parent!,
          localName: binding.name,
          references: findBindingReferences(this.bindings, binding),
        });
      }
    }
    return sites;
  }

  /** `insert(def, { <key>: … })` entries on the declaration's definition — a param's per-instance overrides. */
  private overrideSites(): OverrideSite[] {
    if (this.declaration.kind !== 'param') {
      return [];
    }
    const sites: OverrideSite[] = [];
    for (const node of walkTree(this.tree.rootNode)) {
      if (node.type !== 'call_expression' || node.childForFieldName('function')?.text !== 'insert') {
        continue;
      }
      const args = node.childForFieldName('arguments')?.namedChildren.filter((c) => c.type !== 'comment') ?? [];
      const object = args[1];
      if (!args[0] || !this.isDefinition(args[0]) || object?.type !== 'object') {
        continue;
      }
      for (const entry of object.namedChildren) {
        if (entryKey(entry) === this.declaration.key) {
          sites.push({ kind: 'override', call: node, object, entry });
        }
      }
    }
    return sites;
  }

  /**
   * `configurations({ Row: { <key>: … } })` cells of the declaring body's
   * own table — a param's per-configuration values. The table lives in the
   * same `part()` / `assembly()` body as the declaration (§3.2), so only the
   * declaring file has any, and only the tables of that body count: a
   * second definition in the file may spell the same label for its own
   * parameter.
   */
  private configurationSites(): ConfigurationSite[] {
    if (this.declaration.kind !== 'param' || !this.sameFile) {
      return [];
    }
    const bodies = this.declaringDefinitionCalls();
    if (bodies.length === 0) {
      return [];
    }
    const sites: ConfigurationSite[] = [];
    for (const node of walkTree(this.tree.rootNode)) {
      if (node.type !== 'call_expression' || node.childForFieldName('function')?.text !== 'configurations') {
        continue;
      }
      const definition = enclosingDefinitionCall(node);
      if (!bodies.some((body) => (body === null && definition === null) || (body !== null && isSameNode(body, definition)))) {
        continue;
      }
      const table = node.childForFieldName('arguments')?.namedChildren.find((c) => c.type !== 'comment');
      if (table?.type !== 'object') {
        continue;
      }
      for (const row of table.namedChildren) {
        const object = row.type === 'pair' ? row.childForFieldName('value') : null;
        if (object?.type !== 'object') {
          continue;
        }
        for (const entry of object.namedChildren) {
          if (entryKey(entry) === this.declaration.key) {
            sites.push({ kind: 'configuration', call: node, row, object, entry });
          }
        }
      }
    }
    return sites;
  }

  /**
   * The `part()` / `assembly()` call(s) whose body declares the
   * declaration, in this file — `[null]` for a declaration outside every
   * body. Found from the definition the ref names (the module-level const
   * it binds) rather than from the declaration's own call, which a delete
   * has already taken out by the time its cells are dropped; a definition
   * bound to no const falls back to the body around the declaration's call.
   */
  private declaringDefinitionCalls(): (TSNode | null)[] {
    const { definition } = this.declaration;
    if (definition === null) {
      return [null];
    }
    if (definition.localName !== null) {
      const calls: TSNode[] = [];
      for (const node of walkTree(this.tree.rootNode)) {
        if (node.type !== 'call_expression') {
          continue;
        }
        const callee = node.childForFieldName('function');
        if (callee?.type === 'identifier' && (callee.text === 'part' || callee.text === 'assembly')
          && boundVariable(node) === definition.localName) {
          calls.push(node);
        }
      }
      return calls;
    }
    return findDeclarationCalls(this.tree, 'param')
      .filter((d) => d.key === this.declaration.key
        && (this.declaration.variable === null || d.variable === this.declaration.variable))
      .map((d) => enclosingDefinitionCall(d.call))
      .filter((call): call is TSNode => call !== null);
  }

  /** `<def or instance>.properties.<key>` — a property's reads; `<occurrence>.parts.<key>` — an instance's. */
  private readSites(): UsageSite[] {
    const { kind, key } = this.declaration;
    const accessor = READ_ACCESSORS[kind];
    if (accessor === undefined) {
      return [];
    }
    const sites: UsageSite[] = [];
    for (const node of walkTree(this.tree.rootNode)) {
      if (node.type !== 'member_expression') {
        continue;
      }
      const property = node.childForFieldName('property');
      const object = node.childForFieldName('object');
      if (property?.type !== 'property_identifier' || property.text !== key
        || object?.type !== 'member_expression'
        || object.childForFieldName('property')?.text !== accessor) {
        continue;
      }
      const holder = object.childForFieldName('object');
      if (holder && this.holdsDeclaration(holder)) {
        sites.push({ kind: 'read', member: node, property });
      }
    }
    return sites;
  }

  /**
   * Whether `holder` is what the declaration is read off by name. A
   * property is read off its definition or anything chained off an instance
   * of it. An instance is read off an occurrence of its assembly alone — a
   * longer chain (`occ.parts.arm.parts.<key>`) names another assembly's
   * part, and a definition has no parts until it is inserted.
   */
  private holdsDeclaration(holder: TSNode): boolean {
    if (this.declaration.kind === 'instance') {
      return holder.type === 'identifier' && this.isInstanceOfDefinition(holder);
    }
    return this.isDefinition(holder) || this.isInstanceOfDefinition(holder);
  }

  /** The binding of the declaration's own `const <name> = <kind>(…, '<key>', …)`. */
  private declaringBinding(name: string): Binding | null {
    const candidates = findDeclarationCalls(this.tree, this.declaration.kind)
      .filter((d) => d.key === this.declaration.key && d.variable === name);
    // Two parts of one file may each declare the key under the same name
    // (`const width = param('Width', …)` in both): the declaration is the
    // one in the declaring definition's body, whose reads are its own.
    const bodies = candidates.length > 1 ? this.declaringDefinitionCalls() : [];
    const declaration = candidates.find((d) => {
      const definition = enclosingDefinitionCall(d.call);
      return bodies.some((body) => (body === null && definition === null) || (body !== null && isSameNode(body, definition)));
    }) ?? candidates[0];
    const nameNode = declaration ? outermostExpression(declaration.call).parent?.childForFieldName('name') ?? null : null;
    return nameNode ? bindingOfDeclarator(this.bindings, nameNode) : null;
  }

  /** The import bindings of this file that resolve to the declaring file. */
  private importsOfDeclaringFile(): Binding[] {
    const found: Binding[] = [];
    for (const node of walkTree(this.tree.rootNode)) {
      if (node.type !== 'import_specifier') {
        continue;
      }
      const local = node.childForFieldName('alias') ?? node.childForFieldName('name') ?? node.namedChild(0);
      const binding = local ? this.bindings.resolve(local.text, local) : null;
      if (binding?.kind === 'import' && binding.imported
        && specifierReaches(this.filePath, binding.imported.source, this.declaration.filePath)) {
        found.push(binding);
      }
    }
    return found;
  }

  /** Whether an expression is the declaration's definition: its local const here, its import elsewhere. */
  private isDefinition(node: TSNode): boolean {
    const definition = this.declaration.definition;
    const root = chainRootIdentifier(node);
    if (!definition || !root || !isSameNode(root, node)) {
      return false;
    }
    const binding = this.bindings.resolve(root.text, root);
    if (!binding) {
      return false;
    }
    if (this.sameFile) {
      return binding.kind !== 'import' && binding.scope.type === 'program' && binding.name === definition.localName;
    }
    return binding.kind === 'import' && binding.imported !== undefined
      && binding.imported.name === definition.exportName
      && specifierReaches(this.filePath, binding.imported.source, this.declaration.filePath);
  }

  /** Whether an expression chains off a const bound to `insert(<definition>, …)`. */
  private isInstanceOfDefinition(node: TSNode): boolean {
    const root = chainRootIdentifier(node);
    const binding = root ? this.bindings.resolve(root.text, root) : null;
    if (!binding?.init) {
      return false;
    }
    const source = RenderedProperties.sourceCallOf(binding.init);
    if (source?.kind !== 'insert') {
      return false;
    }
    const definition = source.call.childForFieldName('arguments')?.namedChildren.find((c) => c.type !== 'comment');
    return definition !== undefined && this.isDefinition(definition);
  }

  // -------------------------------------------------------------------------
  // Rewrites
  // -------------------------------------------------------------------------

  /** Apply a usage edit to one file's code — the consumer-side transform of the apply-feature round trip. */
  static async apply(code: string, filePath: string, spec: UsageEditSpec): Promise<{ newCode: string; error?: string }> {
    const usages = await DeclarationUsages.of(code, filePath, spec.declaration);
    const sites = usages.sites();
    if (sites.length === 0) {
      return { newCode: code };
    }
    if (spec.action === 'rename') {
      return { newCode: applySpliceEdits(code, usages.renameEdits(sites, spec.newKey, spec.newVariable, spec.newVariableExport)) };
    }
    const unportable = sites.filter((site) => !isDroppedSite(site));
    if (!spec.portable && unportable.length > 0) {
      return {
        newCode: code,
        error: `the value of "${spec.declaration.key}" only means something in its own file — replace its reads here `
          + `(line${unportable.length === 1 ? '' : 's'} ${unportable.map(usageLine).join(', ')}) by hand first`,
      };
    }
    return { newCode: await usages.inline(code, sites, spec.expression) };
  }

  /**
   * The edits that follow a rename through `sites`. In the declaring file
   * the variable's own reads take `newVariable`; an importing file renames
   * its specifier to the new export and, unless it aliased the import or
   * already declares the new name, its reads too.
   */
  renameEdits(sites: UsageSite[], newKey: string, newVariable: string | null, newVariableExport: string | null): SpliceEdit[] {
    const edits: SpliceEdit[] = [];
    for (const site of sites) {
      switch (site.kind) {
        case 'variable':
          if (newVariable !== null) {
            edits.push(...renameReferenceEdits([site.reference], newVariable));
          }
          break;
        case 'import':
          edits.push(...this.importRenameEdits(site, newVariable, newVariableExport));
          break;
        case 'override':
        case 'configuration':
          edits.push(this.entryRenameEdit(site.entry, newKey));
          break;
        case 'read':
          edits.push({ start: site.property.startIndex, end: site.property.endIndex, text: newKey });
          break;
      }
    }
    return edits;
  }

  private importRenameEdits(
    site: ImportSite,
    newVariable: string | null,
    newVariableExport: string | null,
  ): SpliceEdit[] {
    if (newVariableExport === null || newVariableExport === this.declaration.variableExport) {
      return [];
    }
    const { specifier, localName, references } = site;
    const aliased = specifier.childForFieldName('alias') !== null;
    // An aliased import keeps its local name; so does one whose new name
    // the file already uses — it just gains the alias.
    const newLocal = newVariable ?? newVariableExport;
    if (aliased || declaresName(this.tree, newLocal)) {
      return [{ start: specifier.startIndex, end: specifier.endIndex, text: `${newVariableExport} as ${localName}` }];
    }
    return [
      { start: specifier.startIndex, end: specifier.endIndex, text: newVariableExport },
      ...renameReferenceEdits(references, newLocal),
    ];
  }

  /** The edit that re-keys an override entry or a configuration cell. */
  private entryRenameEdit(entry: TSNode, newKey: string): SpliceEdit {
    if (entry.type === 'shorthand_property_identifier') {
      return { start: entry.startIndex, end: entry.endIndex, text: `${renderKey(newKey)}: ${entry.text}` };
    }
    const key = entry.childForFieldName('key')!;
    return { start: key.startIndex, end: key.endIndex, text: renderKey(newKey) };
  }

  /**
   * Replace every read by `expression` and drop every override and
   * configuration cell, applying `alongside` (the declaration's own
   * removal, in the declaring file) in the same pass. Overrides and cells
   * are removed one at a time, last first, on a re-parsed tree — an entry's
   * removal takes a separator with it and can empty the whole argument (a
   * row emptied of its cells stays as `Row: {}`).
   */
  async inline(code: string, sites: UsageSite[], expression: string, alongside: SpliceEdit[] = []): Promise<string> {
    const atomic = await isAtomicExpression(expression);
    const edits: SpliceEdit[] = [...alongside];
    const overrides: OverrideSite[] = [];
    const cells: ConfigurationSite[] = [];
    for (const site of sites) {
      switch (site.kind) {
        case 'variable':
          edits.push(...inlineReferenceEdits([site.reference], expression, atomic));
          break;
        case 'import':
          edits.push(...inlineReferenceEdits(site.references, expression, atomic));
          edits.push(importSpecifierRemoval(code, site.specifier));
          break;
        case 'read':
          edits.push({
            start: site.member.startIndex,
            end: site.member.endIndex,
            text: expressionInPlaceOf(site.member, expression, atomic),
          });
          break;
        case 'override':
          overrides.push(site);
          break;
        case 'configuration':
          cells.push(site);
          break;
      }
    }
    let out = applySpliceEdits(code, edits);
    if (overrides.length > 0 || cells.length > 0) {
      const parser = await getJavaScriptParser();
      // Locate each entry afresh: the splices above moved everything below them.
      for (let remaining = overrides.length; remaining > 0; remaining--) {
        const tree = parser.parse(out);
        const usages = new DeclarationUsages(tree, this.filePath, this.declaration);
        const last = usages.overrideSites().sort((a, b) => b.entry.startIndex - a.entry.startIndex)[0];
        if (!last) {
          break;
        }
        out = removeObjectEntry(out, last.call, last.object, last.entry);
      }
      for (let remaining = cells.length; remaining > 0; remaining--) {
        const tree = parser.parse(out);
        const usages = new DeclarationUsages(tree, this.filePath, this.declaration);
        const last = usages.configurationSites().sort((a, b) => b.entry.startIndex - a.entry.startIndex)[0];
        if (!last) {
          break;
        }
        out = removeCellEntry(out, last.object, last.entry);
      }
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Deletion planning
  // -------------------------------------------------------------------------

  /**
   * Which of `sites` cannot take the declaration's value in their place.
   * In the declaring file each read is judged on its own: every name the
   * value reads must resolve to the same declaration at the read as at
   * the value — the file holds both scopes. Another file's reads can take
   * the value only when it reads nothing but globals, which is what
   * `portable` reports; an override is dropped, never inlined, so it is
   * never blocked.
   */
  blockedSites(sites: UsageSite[], value: TSNode, portable: boolean): UsageSite[] {
    const free = this.sameFile ? freeIdentifiers(this.bindings, value) : [];
    return sites.filter((site) => {
      if (isDroppedSite(site)) {
        return false;
      }
      // `export { width }` cannot export a number — the export has to go first.
      if (site.kind === 'variable' && site.reference.node.parent?.type === 'export_specifier') {
        return true;
      }
      return !(this.sameFile ? readsSameBindings(this.bindings, free, usageNode(site)) : portable);
    });
  }

  /** Whether the declaration's value reads nothing but globals — whether any file can inline it. */
  static isPortable(bindings: LexicalBindings, value: TSNode): boolean {
    return isPortable(freeIdentifiers(bindings, value));
  }
}

function isPortable(free: FreeIdentifier[]): boolean {
  return free.every((identifier) => identifier.binding === null);
}

/**
 * The edit that drops one specifier from its `import { … }` — the whole
 * statement when it was the only one, else the specifier and a separator.
 */
function importSpecifierRemoval(code: string, specifier: TSNode): SpliceEdit {
  const namedImports = specifier.parent!;
  const specifiers = namedImports.namedChildren.filter((n) => n.type === 'import_specifier');
  const clause = namedImports.parent!;
  const statement = clause.parent!;
  if (specifiers.length === 1 && clause.namedChildren.length === 1) {
    const lines = splitLines(code);
    const row = statement.startPosition.row;
    const aloneOnItsLine = lines[row].slice(0, statement.startPosition.column).trim() === ''
      && lines[statement.endPosition.row].slice(statement.endPosition.column).trim() === '';
    let end = aloneOnItsLine && statement.endPosition.row < lines.length - 1
      ? statement.endIndex + 1
      : statement.endIndex;
    // The file's first line going leaves the blank line under it leading
    // the file — that blank goes too.
    const nextRow = statement.endPosition.row + 1;
    if (aloneOnItsLine && row === 0 && nextRow < lines.length - 1 && lines[nextRow].trim() === '') {
      end += lines[nextRow].length + 1;
    }
    return { start: statement.startIndex, end, text: '' };
  }
  const index = specifiers.findIndex((s) => isSameNode(s, specifier));
  if (specifiers.length === 1) {
    // `import def, { width } from …`: the braces go with their only specifier.
    const before = clause.namedChildren[clause.namedChildren.findIndex((n) => isSameNode(n, namedImports)) - 1];
    return { start: before.endIndex, end: namedImports.endIndex, text: '' };
  }
  if (index === specifiers.length - 1) {
    return { start: specifiers[index - 1].endIndex, end: specifier.endIndex, text: '' };
  }
  return { start: specifier.startIndex, end: specifiers[index + 1].startIndex, text: '' };
}

/**
 * Remove one cell of a `configurations()` row; the row stays as `Row: {}`
 * when the cell was its last — the shape `ConfigurationEditor.unsetCells`
 * leaves behind.
 */
function removeCellEntry(code: string, object: TSNode, entry: TSNode): string {
  const entries = object.namedChildren.filter((c) => c.type !== 'comment');
  const index = entries.findIndex((e) => isSameNode(e, entry));
  if (entries.length === 1) {
    return spliceCode(code, object.startIndex + 1, object.endIndex - 1, '');
  }
  if (index === 0) {
    return spliceCode(code, entries[0].startIndex, entries[1].startIndex, '');
  }
  return spliceCode(code, entries[index - 1].endIndex, entries[index].endIndex, '');
}

/**
 * Remove one entry of an `insert()` override object, the argument itself
 * when the entry was its last — the same shape `applyInsertParamsEdit`
 * leaves behind when an override is reset.
 */
function removeObjectEntry(code: string, call: TSNode, object: TSNode, entry: TSNode): string {
  const args = call.childForFieldName('arguments')!.namedChildren.filter((c) => c.type !== 'comment');
  const entries = object.namedChildren.filter((c) => c.type !== 'comment');
  const index = entries.findIndex((e) => isSameNode(e, entry));
  if (entries.length === 1) {
    return spliceCode(code, args[0].endIndex, object.endIndex, '');
  }
  if (index === 0) {
    return spliceCode(code, entries[0].startIndex, entries[1].startIndex, '');
  }
  return spliceCode(code, entries[index - 1].endIndex, entries[index].endIndex, '');
}

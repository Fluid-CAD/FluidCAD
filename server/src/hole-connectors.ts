// The connectors a removed hole leaves behind.
//
// A hole placed on a face or an edge inside a part gets a connector of its
// own from the dialog (`const h1 = connector('h1', e.endFaces().center())`),
// and a hole placed at an existing connector binds that one to a name. Either
// way the connector statement outlives the hole unless the removal takes it
// along — a frame in the Connectors rail marking a hole that is gone.
//
// A connector goes with its hole only when nothing else reads it, and a
// connector is read two ways: through the variable its statement binds (a
// second hole, a `copy()`, a returned object), and by name off the part that
// declares it — `<instance>.connectors.<name>`, in this file or in any
// assembly that inserts the part. `HoleConnectors` answers the first and the
// same-file half of the second from one tree; `WorkspaceConnectorReads`
// answers for the other files of the workspace.

import {
  LexicalBindings,
  RenderedProperties,
  getJavaScriptParser,
  stringLiteralValue,
  walkTree,
  type Binding,
  type TSNode,
  type TSTree,
} from './code-editor/index.ts';
import { bindingOfDeclarator, findBindingReferences } from './code-editor/binding-references.ts';
import { findDeclarationCalls, isSameNode, outermostExpression } from './code-editor/declaration-calls.ts';
import { enclosingDefinition, specifierReaches, type DeclarationRef } from './declaration-usages.ts';
import { normalizePath } from './normalize-path.ts';
import { StatementAnalysis } from './statement-analysis.ts';
import type { WorkspaceScripts } from './workspace-scripts.ts';

/**
 * How the model outside a connector's own scope addresses it: by name, off
 * the definition whose body declares it.
 */
export type ConnectorOwner = {
  /** The connector's name — the `'h1'` of `connector('h1', …)`. */
  name: string;
  /** The `part()` around it, as other code names it; null at a file's top level. */
  definition: DeclarationRef['definition'];
};

/** A `const <variable> = connector('<name>', …)` statement a hole is placed at. */
export type HoleConnector = {
  statement: TSNode;
  variable: string;
  owner: ConnectorOwner;
};

type DeclaredConnector = HoleConnector & { binding: Binding };

export class HoleConnectors extends StatementAnalysis {
  /**
   * The connectors deleting `doomed` orphans, in document order: each one a
   * placement of a hole among the doomed statements, with every read of it —
   * of its variable, and of its name off its part — inside a statement that
   * goes. A connector only another orphan reads goes too. `allowed` narrows
   * what may go at all; a connector it refuses stays, and keeps whatever it
   * reads.
   */
  static orphanedBy(
    tree: TSTree,
    doomed: TSNode[],
    allowed: (connector: HoleConnector) => boolean = () => true,
  ): HoleConnector[] {
    const bindings = new LexicalBindings(tree);
    const placed = HoleConnectors.placedBy(tree, bindings, doomed).filter(allowed).map(connector => ({
      connector,
      reads: [
        ...findBindingReferences(bindings, connector.binding).map(reference => reference.node),
        ...ConnectorReads.inDeclaringFile(tree, connector.owner).sites(),
      ],
    }));
    const orphaned: DeclaredConnector[] = [];
    const goes = (node: TSNode): boolean =>
      doomed.some(stmt => HoleConnectors.within(node, stmt))
      || orphaned.some(connector => HoleConnectors.within(node, connector.statement));
    for (let changed = placed.length > 0; changed; ) {
      changed = false;
      for (const { connector, reads } of placed) {
        if (!orphaned.includes(connector) && reads.every(goes)) {
          orphaned.push(connector);
          changed = true;
        }
      }
    }
    return orphaned
      .sort((a, b) => a.statement.startIndex - b.statement.startIndex)
      .map(({ statement, variable, owner }) => ({ statement, variable, owner }));
  }

  /**
   * The connector declarations the holes of `doomed` are placed at, the ones
   * `doomed` already deletes left out. A placement names its connector by
   * the variable — bare, or under a chain such as `bolt.instance(2)`.
   */
  private static placedBy(tree: TSTree, bindings: LexicalBindings, doomed: TSNode[]): DeclaredConnector[] {
    const declared = HoleConnectors.declarations(tree, bindings)
      .filter(connector => !doomed.some(stmt => HoleConnectors.within(connector.statement, stmt)));
    if (declared.length === 0) {
      return [];
    }
    const placed = new Set<DeclaredConnector>();
    for (const stmt of doomed) {
      for (const call of HoleConnectors.evaluatedCalls(stmt)) {
        const callee = call.childForFieldName('function');
        if (callee?.type !== 'identifier' || callee.text !== 'hole') {
          continue;
        }
        const args = call.childForFieldName('arguments')?.namedChildren.filter(c => c.type !== 'comment') ?? [];
        for (const placement of args.slice(1)) {
          for (const node of walkTree(placement)) {
            if (node.type !== 'identifier') {
              continue;
            }
            const binding = bindings.resolve(node.text, node);
            const connector = binding ? declared.find(d => isSameNode(d.binding.id, binding.id)) : undefined;
            if (connector) {
              placed.add(connector);
            }
          }
        }
      }
    }
    return [...placed];
  }

  /**
   * Every connector statement of the file that can be deleted on its own:
   * a `const` / `let` standing in a block (an exported binding is someone
   * else's input), binding one plain name to a `connector('<name>', …)`
   * chain.
   */
  private static declarations(tree: TSTree, bindings: LexicalBindings): DeclaredConnector[] {
    const out: DeclaredConnector[] = [];
    for (const declaration of findDeclarationCalls(tree, 'connector')) {
      if (declaration.variable === null) {
        continue;
      }
      const declarator = outermostExpression(declaration.call).parent!;
      const statement = declarator.parent;
      if (statement?.type !== 'lexical_declaration' || statement.namedChildren.length !== 1) {
        continue;
      }
      if (statement.parent?.type !== 'statement_block' && statement.parent?.type !== 'program') {
        continue;
      }
      const binding = bindingOfDeclarator(bindings, declarator.childForFieldName('name')!);
      if (!binding) {
        continue;
      }
      out.push({
        statement,
        variable: declaration.variable,
        binding,
        owner: { name: declaration.key, definition: enclosingDefinition(tree, bindings, declaration.call) },
      });
    }
    return out;
  }
}

/**
 * The by-name reads one file makes of a connector: `<holder>.connectors.<name>`
 * where the holder is, or may be, the part that declares it or an instance of
 * that part.
 *
 * The answer decides whether a connector is deleted, so it errs towards a
 * read: a holder counts unless it provably is another definition — a
 * different `part()` of the file, an import of something else, or an
 * `insert()` of either. A holder reached through a sub-assembly
 * (`occ.parts.arm.connectors.pivot`), a replica, a function parameter — any
 * holder this cannot trace — counts.
 */
export class ConnectorReads {
  private readonly bindings: LexicalBindings;

  private constructor(
    private readonly tree: TSTree,
    private readonly owner: ConnectorOwner,
    /** The file being read and the declaring file its imports may reach; null when they are the same file. */
    private readonly outside: { filePath: string; declaringFile: string } | null,
  ) {
    this.bindings = new LexicalBindings(tree);
  }

  /** The reads in the file that declares the connector. */
  static inDeclaringFile(tree: TSTree, owner: ConnectorOwner): ConnectorReads {
    return new ConnectorReads(tree, owner, null);
  }

  /** The reads in `filePath`, a file other than `declaringFile`. */
  static inOtherFile(tree: TSTree, filePath: string, declaringFile: string, owner: ConnectorOwner): ConnectorReads {
    return new ConnectorReads(tree, owner, { filePath, declaringFile: normalizePath(declaringFile) });
  }

  /** The `<holder>.connectors` node of every read, in source order. */
  sites(): TSNode[] {
    const sites: TSNode[] = [];
    for (const node of walkTree(this.tree.rootNode)) {
      if (node.type !== 'member_expression' || node.childForFieldName('property')?.text !== 'connectors') {
        continue;
      }
      const holder = node.childForFieldName('object');
      if (holder && this.selectsConnector(node) && this.mayHoldConnector(holder)) {
        sites.push(node);
      }
    }
    return sites;
  }

  /**
   * Whether what is done with a `.connectors` object reaches this
   * connector: `.<name>` and `['<name>']` do, another name does not, and
   * anything else — a computed key, a destructuring, the object handed on —
   * may.
   */
  private selectsConnector(connectors: TSNode): boolean {
    const parent = connectors.parent;
    if (!parent || !isSameNode(parent.childForFieldName('object'), connectors)) {
      return true;
    }
    if (parent.type === 'member_expression') {
      return parent.childForFieldName('property')?.text === this.owner.name;
    }
    if (parent.type === 'subscript_expression') {
      const index = parent.childForFieldName('index');
      const key = index ? stringLiteralValue(index) : null;
      return key === null || key === this.owner.name;
    }
    return true;
  }

  private mayHoldConnector(holder: TSNode): boolean {
    if (ConnectorReads.hopsThroughParts(holder)) {
      return true;
    }
    const root = ConnectorReads.holderRoot(holder);
    if (!root) {
      return true;
    }
    if (root.type === 'identifier') {
      const binding = this.bindings.resolve(root.text, root);
      return binding ? this.mayBeOwner(binding, false) : true;
    }
    // A call's own result: `insert(plate).connectors.h1` is traced through
    // its definition, an inline `part()` is the owner at most in the file
    // that declares the connector, and any other function's result is
    // anyone's guess.
    const source = RenderedProperties.sourceCallOf(root);
    if (!source) {
      return true;
    }
    return source.kind === 'part' ? this.outside === null : this.insertedMayBeOwner(source.call);
  }

  /**
   * What a holder chain hangs off: the variable under its member accesses
   * and method calls (`p1` in `p1.instance(2)`), or the plain function call
   * whose result it reads (`insert(plate)` in `insert(plate).grounded()`).
   * Null for anything else — `this`, a literal.
   */
  private static holderRoot(holder: TSNode): TSNode | null {
    let current: TSNode | null = holder;
    while (current) {
      switch (current.type) {
        case 'identifier':
          return current;
        case 'member_expression':
        case 'subscript_expression':
          current = current.childForFieldName('object');
          break;
        case 'parenthesized_expression':
          current = current.namedChild(0);
          break;
        case 'call_expression': {
          const callee: TSNode | null = current.childForFieldName('function');
          if (callee?.type === 'identifier') {
            return current;
          }
          current = callee?.type === 'member_expression' ? callee.childForFieldName('object') : null;
          break;
        }
        default:
          return null;
      }
    }
    return null;
  }

  /** Whether a chain passes through `.parts` — a sub-assembly's instances, which no binding of this file names. */
  private static hopsThroughParts(holder: TSNode): boolean {
    let current: TSNode | null = holder;
    while (current) {
      switch (current.type) {
        case 'member_expression':
          if (current.childForFieldName('property')?.text === 'parts') {
            return true;
          }
          current = current.childForFieldName('object');
          break;
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
          return false;
      }
    }
    return false;
  }

  /**
   * Whether a binding is, or may be, the connector's part or an instance of
   * it. Only a traced definition can answer no; `throughInsert` stops the
   * trace at one `insert()`, the only hop an instance makes.
   */
  private mayBeOwner(binding: Binding, throughInsert: boolean): boolean {
    if (binding.kind === 'import') {
      return this.importMayBeOwner(binding);
    }
    if (binding.init === null || binding.destructured) {
      return true;
    }
    const source = RenderedProperties.sourceCallOf(binding.init);
    if (!source) {
      return true;
    }
    if (source.kind === 'part') {
      return this.isOwnDefinition(binding);
    }
    return throughInsert ? true : this.insertedMayBeOwner(source.call);
  }

  /** Whether an `insert(<definition>, …)` call may make an instance of the connector's part. */
  private insertedMayBeOwner(insertCall: TSNode): boolean {
    const definition = insertCall.childForFieldName('arguments')?.namedChildren.find(c => c.type !== 'comment');
    if (definition?.type !== 'identifier') {
      return true;
    }
    const defined = this.bindings.resolve(definition.text, definition);
    return defined ? this.mayBeOwner(defined, true) : true;
  }

  /**
   * A `part()` bound in the file being read is the owner only in the
   * declaring file: under its module-level name when it has one, else as
   * any part no module-level name binds.
   */
  private isOwnDefinition(binding: Binding): boolean {
    if (this.outside !== null || this.owner.definition === null) {
      return false;
    }
    const moduleLevel = binding.scope.type === 'program';
    const { localName } = this.owner.definition;
    return localName === null ? !moduleLevel : moduleLevel && binding.name === localName;
  }

  /**
   * An import is the owner when it reaches the declaring file and names the
   * definition's export — or cannot be told apart from it (a default or
   * namespace import, a definition with no known export name).
   */
  private importMayBeOwner(binding: Binding): boolean {
    if (this.outside === null) {
      return false;
    }
    const imported = binding.imported;
    if (!imported) {
      return true;
    }
    if (!specifierReaches(this.outside.filePath, imported.source, this.outside.declaringFile)) {
      return false;
    }
    const exportName = this.owner.definition?.exportName ?? null;
    return exportName === null || imported.name === exportName || imported.name === 'default' || imported.name === '*';
  }
}

/** The by-name reads of a file's connectors in the rest of the workspace. */
export class WorkspaceConnectorReads {
  constructor(private readonly scripts: WorkspaceScripts) {}

  /**
   * `connectors` — declared in `declaringFile` — without the ones another
   * workspace script reads by name. A script that never says `connectors`
   * is not even parsed.
   */
  async unread(declaringFile: string, connectors: HoleConnector[]): Promise<HoleConnector[]> {
    let unread = connectors;
    if (unread.length === 0) {
      return unread;
    }
    const parser = await getJavaScriptParser();
    for (const { filePath, code } of await this.scripts.others(declaringFile)) {
      if (!code.includes('connectors')) {
        continue;
      }
      const tree = parser.parse(code);
      unread = unread.filter(connector =>
        ConnectorReads.inOtherFile(tree, filePath, declaringFile, connector.owner).sites().length === 0);
      if (unread.length === 0) {
        break;
      }
    }
    return unread;
  }
}

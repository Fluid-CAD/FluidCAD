import { chainBaseCall, walkTree } from './nodes.ts';
import { getParser, type TSNode } from './parser.ts';

type Position = { line: number; column: number };
type Site = Position & { endLine: number; endColumn: number; signature: string };

/**
 * Relocate known calls, without knowing which API they call. Callback bodies
 * are excluded from a container's signature: adding a breakpoint or a child
 * changes the body, not the container's identity. Everything else must still
 * match, including chains and enclosing functions. Ambiguous calls are never
 * followed across an edit.
 */
export class CallSites {
  private readonly signatures = new Map<string, Site[]>();

  private constructor(private readonly sites: Site[]) {
    sites.sort((a, b) => a.line - b.line || a.column - b.column);
    for (const site of sites) {
      const group = this.signatures.get(site.signature) ?? [];
      group.push(site);
      this.signatures.set(site.signature, group);
    }
  }

  static async parse(code: string): Promise<CallSites> {
    const tree = (await getParser()).parse(code);
    try {
      const calls = new Map<number, TSNode>();
      for (const node of walkTree(tree.rootNode)) {
        if (node.type !== 'call_expression') continue;
        const root = chainBaseCall(node);
        const known = calls.get(root.startIndex);
        if (!known || known.endIndex < node.endIndex) calls.set(root.startIndex, node);
      }
      const sites: Site[] = [];
      for (const call of calls.values()) {
        const scopes: unknown[] = [];
        for (let parent = call.parent; parent; parent = parent.parent) {
          if (CallSites.isFunction(parent)) {
            const owner = parent.parent?.type === 'arguments' ? parent.parent.parent : null;
            scopes.push(owner?.type === 'call_expression'
              ? CallSites.signature(owner) : CallSites.signature(parent));
          }
        }
        sites.push({
          line: call.startPosition.row + 1, column: call.startPosition.column + 1,
          endLine: call.endPosition.row + 1, endColumn: call.endPosition.column + 1,
          signature: JSON.stringify([scopes.reverse(), CallSites.signature(call)]),
        });
      }
      return new CallSites(sites);
    } finally {
      // Trees own WASM memory. Keep only plain descriptors between renders.
      (tree as typeof tree & { delete?: () => void }).delete?.();
    }
  }

  private static isFunction(node: TSNode): boolean {
    return ['arrow_function', 'function', 'function_expression', 'function_declaration'].includes(node.type);
  }

  private static signature(node: TSNode): unknown {
    if (CallSites.isFunction(node)) {
      return [node.type, node.childForFieldName('name')?.text,
        node.childForFieldName('parameters')?.text ?? node.childForFieldName('parameter')?.text];
    }
    if (node.type === 'call_expression') {
      const fn = node.childForFieldName('function');
      return [fn ? CallSites.signature(fn) : '',
        node.childForFieldName('arguments')?.namedChildren.filter(n => n.type !== 'comment').map(CallSites.signature)];
    }
    if (node.type === 'member_expression') {
      const object = node.childForFieldName('object');
      return [object ? CallSites.signature(object) : '', node.childForFieldName('property')?.text];
    }
    return node.text;
  }

  /** Smallest enclosing call, so two statements on one line stay distinct. */
  at(position: Position): Site | undefined {
    let low = 0;
    let high = this.sites.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      const site = this.sites[mid];
      if (site.line < position.line || site.line === position.line && site.column <= position.column) low = mid + 1;
      else high = mid;
    }
    // Most locations point at a call's start. The backward fallback handles
    // a frame pointing into a containing call after one of its arguments.
    for (let i = low - 1; i >= 0; i--) {
      const site = this.sites[i];
      if (position.line < site.endLine || position.line === site.endLine && position.column < site.endColumn) return site;
    }
    return undefined;
  }

  relocate(position: Position, next: CallSites): Position | undefined {
    const site = this.at(position);
    if (!site) return undefined;
    const before = this.signatures.get(site.signature)!;
    const after = next.signatures.get(site.signature);
    if (before.length !== 1 || after?.length !== 1) return undefined;
    return { line: after[0].line, column: after[0].column };
  }
}

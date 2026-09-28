// The `property()` values an `insert()` call's instance carried in the last render, found from the call.

import { normalizePath } from '../normalize-path.ts';
import type { TSNode } from './parser.ts';

/** A rendered value a `property()` can hold — what the assembly reads as `instance.properties.<name>`. */
export type InstancePropertyValue = string | number | boolean | (string | number)[];

/** The slice of a rendered instance this reads — the render's serialized instance carries more. */
export type RenderedInstanceProperties = {
  sourceLocation?: { filePath: string; line: number; column?: number };
  properties?: Record<string, InstancePropertyValue>;
  /** Set on a `replicate()` copy, whose location is the replicate statement's, never an `insert()`. */
  replica?: unknown;
};

/** Only a property spelled as an identifier reads as `instance.properties.<name>`. */
const IDENTIFIER_RE = /^[A-Za-z_$][\w$]*$/;

/**
 * Which rendered instance each `insert()` call of one file created, so a
 * name bound to that call (`const drawer = insert(Drawer, …)`) can offer
 * and resolve the instance's computed properties. An instance belongs to
 * the call that created it — same file, same line, as the render stamps
 * the call's own location — and a replica belongs to none. A call nothing
 * matches (the buffer moved since the render, the render failed) has no
 * properties to read.
 */
export class InstanceProperties {
  /** Each instance's properties by the 1-based line of the `insert()` call that created it. */
  private readonly byLine = new Map<number, Record<string, InstancePropertyValue>>();

  constructor(filePath: string, instances: readonly RenderedInstanceProperties[]) {
    const here = normalizePath(InstanceProperties.stripVirtual(filePath));
    for (const instance of instances) {
      const location = instance.sourceLocation;
      if (!location || instance.replica !== undefined || !instance.properties) {
        continue;
      }
      if (normalizePath(InstanceProperties.stripVirtual(location.filePath)) !== here) {
        continue;
      }
      // Two inserts on one line: the first keeps the line, as the render built it first.
      if (!this.byLine.has(location.line)) {
        this.byLine.set(location.line, instance.properties);
      }
    }
  }

  /** No render to read from: every call is unmatched. */
  static none(): InstanceProperties {
    return new InstanceProperties('', []);
  }

  /**
   * The properties of the instance the `insert()` call `call` created, by
   * identifier-shaped name — the only names `instance.properties.<name>`
   * can spell. Null when no rendered instance is the call's.
   */
  ofCall(call: TSNode): Record<string, InstancePropertyValue> | null {
    const properties = this.byLine.get(call.startPosition.row + 1);
    if (!properties) {
      return null;
    }
    const readable: Record<string, InstancePropertyValue> = {};
    for (const [name, value] of Object.entries(properties)) {
      if (IDENTIFIER_RE.test(name)) {
        readable[name] = value;
      }
    }
    return readable;
  }

  /**
   * The `insert(…)` call a binding's value is built on, or null. An instance
   * handle is often bound through its own methods — `insert(box, …)
   * .grounded()`, `.translate(…)` — each returning the handle, so the
   * chain is unwound down to the call that created it.
   */
  static insertCallOf(value: TSNode): TSNode | null {
    let node: TSNode | null = value;
    while (node && node.type === 'call_expression') {
      const fn = node.childForFieldName('function');
      if (fn?.type === 'identifier') {
        return fn.text === 'insert' ? node : null;
      }
      node = fn?.type === 'member_expression' ? fn.childForFieldName('object') : null;
    }
    return null;
  }

  private static stripVirtual(filePath: string): string {
    return filePath.replace(/^virtual:live-render:/, '');
  }
}

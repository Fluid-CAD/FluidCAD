// The `property()` values the last render computed, found from the call whose binding publishes them.

import { normalizePath } from '../normalize-path.ts';
import type { TSNode } from './parser.ts';

/** A rendered value a `property()` can hold — what `<binding>.properties.<name>` reads. */
export type RenderedPropertyValue = string | number | boolean | (string | number)[];

/** Where the render stamped the call that produced a property-bearing object. */
export type RenderedSourceLocation = { filePath: string; line: number; column?: number };

/** The slice of a rendered instance this reads — the render's serialized instance carries more. */
export type RenderedInstanceProperties = {
  sourceLocation?: RenderedSourceLocation;
  properties?: Record<string, RenderedPropertyValue>;
  /** Set on a `replicate()` copy, whose location is the replicate statement's, never an `insert()`. */
  replica?: unknown;
};

/**
 * The default variant of one `part()` definition the last render built,
 * located at the `part()` call — what `def.properties.<name>` reads.
 */
export type RenderedPartProperties = {
  sourceLocation?: RenderedSourceLocation;
  properties?: Record<string, RenderedPropertyValue>;
};

/** Everything the last render computed that a binding can read properties from. */
export type RenderedPropertySources = {
  instances?: readonly RenderedInstanceProperties[];
  parts?: readonly RenderedPartProperties[];
};

/**
 * The two calls whose result publishes `property()` values: an `insert()`
 * holds the instance it created, a `part()` holds the definition whose
 * default variant it reads through.
 */
export type PropertySourceKind = 'insert' | 'part';

/** A call a binding reads properties through, with which kind of object it produced. */
export type PropertySourceCall = { kind: PropertySourceKind; call: TSNode };

/** Only a property spelled as an identifier reads as `<binding>.properties.<name>`. */
const IDENTIFIER_RE = /^[A-Za-z_$][\w$]*$/;

/**
 * Which rendered object each property-producing call of one file created,
 * so a name bound to that call — `const drawer = insert(Drawer, …)`, or
 * `const box = part('Box', () => { … })` — can offer and resolve the
 * object's computed properties. An object belongs to the call that
 * created it — same file, same line, as the render stamps the call's own
 * location — and a replica belongs to none. A `part()` binding reads the
 * definition's DEFAULT variant, the one `def.properties` serves; an
 * inserted variant's own values live on its instance. A call nothing
 * matches (the buffer moved since the render, the render failed) has no
 * properties to read.
 */
export class RenderedProperties {
  /** Each object's properties by kind and by the 1-based line of the call that created it. */
  private readonly byLine: Record<PropertySourceKind, Map<number, Record<string, RenderedPropertyValue>>> = {
    insert: new Map(),
    part: new Map(),
  };

  constructor(filePath: string, sources: RenderedPropertySources) {
    const here = normalizePath(RenderedProperties.stripVirtual(filePath));
    for (const instance of sources.instances ?? []) {
      if (instance.replica === undefined) {
        this.index('insert', here, instance);
      }
    }
    for (const part of sources.parts ?? []) {
      this.index('part', here, part);
    }
  }

  /** No render to read from: every call is unmatched. */
  static none(): RenderedProperties {
    return new RenderedProperties('', {});
  }

  private index(kind: PropertySourceKind, here: string, source: RenderedPartProperties): void {
    const location = source.sourceLocation;
    if (!location || !source.properties) {
      return;
    }
    if (normalizePath(RenderedProperties.stripVirtual(location.filePath)) !== here) {
      return;
    }
    // Two calls on one line: the first keeps the line, as the render built it first.
    const lines = this.byLine[kind];
    if (!lines.has(location.line)) {
      lines.set(location.line, source.properties);
    }
  }

  /**
   * The properties of the object `source` created, by identifier-shaped
   * name — the only names `<binding>.properties.<name>` can spell. Null
   * when no rendered object is the call's.
   */
  of(source: PropertySourceCall): Record<string, RenderedPropertyValue> | null {
    const properties = this.byLine[source.kind].get(source.call.startPosition.row + 1);
    if (!properties) {
      return null;
    }
    const readable: Record<string, RenderedPropertyValue> = {};
    for (const [name, value] of Object.entries(properties)) {
      if (IDENTIFIER_RE.test(name)) {
        readable[name] = value;
      }
    }
    return readable;
  }

  /**
   * The `insert(…)` or `part(…)` call a binding's value is built on, or
   * null for any other value. Either handle is often bound through its own
   * methods — `insert(box, …).grounded()`, `part('Box', …).name('Carcase')`
   * — each returning the handle, so the chain is unwound down to the call
   * that created it.
   */
  static sourceCallOf(value: TSNode): PropertySourceCall | null {
    let node: TSNode | null = value;
    while (node && node.type === 'call_expression') {
      const fn = node.childForFieldName('function');
      if (fn?.type === 'identifier') {
        return fn.text === 'insert' || fn.text === 'part' ? { kind: fn.text, call: node } : null;
      }
      node = fn?.type === 'member_expression' ? fn.childForFieldName('object') : null;
    }
    return null;
  }

  private static stripVirtual(filePath: string): string {
    return filePath.replace(/^virtual:live-render:/, '');
  }
}

import type { ParamDefinition } from './param-registry.js';
import { PartIdentity } from './features/part-identity.js';

/** The slice of a definition its identity is read from. */
type KeyedDefinition = Pick<ParamDefinition, 'kind' | 'label' | 'body' | 'bodyName'>;

/** A body declaring a label: its identity (`ParamDefinition.body`) and its definition name, which is only its label. */
export type ParamBodyHolder = { body: string; name: string };

/**
 * What a reference means against a render: the one parameter it names
 * (keyed by its body when a body declares it, the bare label when none does
 * yet), or a refusal naming every body it could mean, by identity.
 */
export type ParamLabelResolution = { key: ParamKey } | { error: string; bodies: string[] };

/**
 * A parameter's identity in one render: the `part()` / `assembly()` body
 * that declared it, by the body's identity, plus its label. Two parts of a
 * file may each declare `Width`; they are two parameters, each with its own
 * Parameters-panel row, session override and baseline — and so are two
 * parts that share a NAME, since a part's body identity is its hidden
 * `PartIdentity` (the export binding, `export const lid = part('Plate', …)`
 * → `lid`, else `Plate#2`), not its name. An assembly's is its name.
 *
 * The body is not the `part()` statement's location: an override outlives
 * the edits that move the statement (typing above it shifts its line), and
 * the configuration tables a render records are filed under the same
 * identity. The statement location stays on `ParamDefinition.part` for the
 * source edits that need it. A project parameter (`kind: 'global'`) has no
 * body — one declaration per label, shared by every file — and neither does
 * a label-only reference (an older client's override, a label not declared
 * yet). A key from before bodies had an identity names the body by its
 * definition name (`["Plate","Width"]`); {@link resolveBody} reads it as the
 * one body of that name.
 *
 * {@link id} is the one encoding of a key, for maps and the wire: the bare
 * label for a key without a body, so every label-keyed map and record from
 * before the body existed still reads; a JSON pair otherwise.
 */
export class ParamKey {

  private constructor(
    /** The declaring body's identity; null for a project parameter or a label-only reference. */
    readonly body: string | null,
    readonly label: string,
  ) {}

  /** The key of `label` declared in `body` (none: a label-only key). */
  static of(body: string | null | undefined, label: string): ParamKey {
    return new ParamKey(body ?? null, label);
  }

  /** A definition's own key — a project parameter's is its label alone. */
  static ofDefinition(def: KeyedDefinition): ParamKey {
    return new ParamKey(def.kind === 'global' ? null : def.body ?? null, def.label);
  }

  /**
   * Read an {@link id} back. Anything that is not a well-formed pair is a
   * label: a label that merely starts like one keeps meaning itself.
   */
  static parse(id: string): ParamKey {
    if (id.startsWith('["')) {
      try {
        const parsed: unknown = JSON.parse(id);
        if (Array.isArray(parsed) && parsed.length === 2
          && typeof parsed[0] === 'string' && typeof parsed[1] === 'string') {
          return new ParamKey(parsed[0], parsed[1]);
        }
      } catch {
        // Not a pair — the whole string is the label.
      }
    }
    return new ParamKey(null, id);
  }

  /** The encoding maps and the wire store: the label alone without a body, else `["body","label"]`. */
  get id(): string {
    return this.body === null ? this.label : JSON.stringify([this.body, this.label]);
  }

  /** Whether the key names no body — a project parameter, or a reference by label only. */
  get labelOnly(): boolean {
    return this.body === null;
  }

  /** The same body's parameter under another label — a rename. */
  withLabel(label: string): ParamKey {
    return new ParamKey(this.body, label);
  }

  equals(other: ParamKey): boolean {
    return this.body === other.body && this.label === other.label;
  }

  /** For messages: `'Width'`, or `'Width' of 'Plate'`. */
  describe(): string {
    return this.body === null ? `'${this.label}'` : `'${this.label}' of '${this.body}'`;
  }

  /**
   * label → the bodies declaring it, in first-declared order, over a
   * render's part and assembly parameters (project parameters never take
   * an override, so they never make a label ambiguous).
   */
  static holdersOf(definitions: Iterable<KeyedDefinition>): Map<string, ParamBodyHolder[]> {
    const holders = new Map<string, ParamBodyHolder[]>();
    for (const def of definitions) {
      if (def.kind === 'global' || def.body === undefined) {
        continue;
      }
      const bodies = holders.get(def.label) ?? [];
      if (!bodies.some(holder => holder.body === def.body)) {
        bodies.push({ body: def.body, name: def.bodyName ?? def.body });
      }
      holders.set(def.label, bodies);
    }
    return holders;
  }

  /**
   * The parameter a label-only reference means: the one body declaring the
   * label, a label-only key when none does (not declared yet — the render
   * reads it as a label-only override), or a refusal when several do, since
   * a value meant for one part must not land on another.
   */
  static resolveLabel(label: string, holders: ReadonlyMap<string, readonly ParamBodyHolder[]>): ParamLabelResolution {
    const bodies = holders.get(label) ?? [];
    if (bodies.length <= 1) {
      return { key: new ParamKey(bodies[0]?.body ?? null, label) };
    }
    return {
      error: `Parameter '${label}' is declared by ${ParamKey.list(ParamKey.labels(bodies))} — name the part (body) whose parameter to set.`,
      bodies: bodies.map(holder => holder.body),
    };
  }

  /**
   * The parameter a reference naming a body means: the body of that
   * identity declaring the label; else — a key from before bodies had an
   * identity, which named the body by its definition name — the one body
   * of that name declaring it, refused when several parts share the name;
   * else the key as given (a body no render has declared the label in yet).
   */
  static resolveBody(body: string, label: string, holders: ReadonlyMap<string, readonly ParamBodyHolder[]>): ParamLabelResolution {
    const bodies = holders.get(label) ?? [];
    if (bodies.some(holder => holder.body === body)) {
      return { key: new ParamKey(body, label) };
    }
    const named = bodies.filter(holder => holder.name === body);
    if (named.length === 1) {
      return { key: new ParamKey(named[0].body, label) };
    }
    if (named.length > 1) {
      const keys = named.map(holder => JSON.stringify([holder.body, label]));
      return {
        error: `'${body}' names ${named.length} parts that declare '${label}' — ${ParamKey.list(ParamKey.labels(named))}. `
          + `Key the parameter by its part's id: ${ParamKey.list(keys, 'or')}.`,
        bodies: named.map(holder => holder.body),
      };
    }
    return { key: new ParamKey(body, label) };
  }

  /**
   * How messages name each of `bodies`: its definition name, with its
   * identity's tag when another of them has the same name (`Plate (lid)`),
   * quoted.
   */
  static labels(bodies: readonly ParamBodyHolder[]): string[] {
    return bodies.map(holder => {
      const shared = bodies.some(other => other.body !== holder.body && other.name === holder.name);
      return `'${PartIdentity.label(holder.name, holder.body, shared)}'`;
    });
  }

  /** `a`, `a and b`, `a, b and c`. */
  private static list(items: readonly string[], conjunction = 'and'): string {
    if (items.length <= 2) {
      return items.join(` ${conjunction} `);
    }
    return `${items.slice(0, -1).join(', ')} ${conjunction} ${items[items.length - 1]}`;
  }
}

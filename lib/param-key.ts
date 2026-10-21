import type { ParamDefinition } from './param-registry.js';

/** The slice of a definition its identity is read from. */
type KeyedDefinition = Pick<ParamDefinition, 'kind' | 'label' | 'body'>;

/**
 * What a label-only reference means against a render: the one parameter
 * that label names (keyed by its body when a body declares it, the bare
 * label when none does yet), or a refusal naming every body that declares
 * it.
 */
export type ParamLabelResolution = { key: ParamKey } | { error: string; bodies: string[] };

/**
 * A parameter's identity in one render: the `part()` / `assembly()` body
 * that declared it, by its definition name, plus its label. Two parts of a
 * file may each declare `Width`; they are two parameters, each with its own
 * Parameters-panel row, session override and baseline.
 *
 * The body is the definition NAME, not the `part()` statement's location:
 * an override outlives the edits that move the statement (typing above it
 * shifts its line), and the configuration tables a render records are filed
 * under the same name. The statement location stays on
 * `ParamDefinition.part` for the source edits that need it. A project
 * parameter (`kind: 'global'`) has no body — one declaration per label,
 * shared by every file — and neither does a label-only reference (an older
 * client's override, a label not declared yet).
 *
 * {@link id} is the one encoding of a key, for maps and the wire: the bare
 * label for a key without a body, so every label-keyed map and record from
 * before the body existed still reads; a JSON pair otherwise.
 */
export class ParamKey {

  private constructor(
    /** The declaring body's definition name; null for a project parameter or a label-only reference. */
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
  static holdersOf(definitions: Iterable<KeyedDefinition>): Map<string, string[]> {
    const holders = new Map<string, string[]>();
    for (const def of definitions) {
      if (def.kind === 'global' || def.body === undefined) {
        continue;
      }
      const bodies = holders.get(def.label) ?? [];
      if (!bodies.includes(def.body)) {
        bodies.push(def.body);
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
  static resolveLabel(label: string, holders: ReadonlyMap<string, readonly string[]>): ParamLabelResolution {
    const bodies = holders.get(label) ?? [];
    if (bodies.length <= 1) {
      return { key: new ParamKey(bodies[0] ?? null, label) };
    }
    const named = bodies.map(b => `'${b}'`);
    const list = named.length === 2 ? named.join(' and ') : `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}`;
    return {
      error: `Parameter '${label}' is declared by ${list} — name the part (body) whose parameter to set.`,
      bodies: bodies.slice(),
    };
  }
}

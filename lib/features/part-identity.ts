/**
 * A `part()` body's hidden identity in its file: what the body's parameters,
 * session overrides, configured values and `configurations()` table are
 * filed under (`ParamDefinition.body`, `ParamKey.body`,
 * `ConfigurationTable.definition`). The part's NAME is only its label — two
 * `part('Plate', …)` of one file are two parts, the way a CAD feature tree
 * keeps a hidden id per feature and shows the name.
 *
 * The identity is the part's export binding: `export const lid =
 * part('Plate', …)` is `lid`, the name the part catalog lists the part
 * under. It is unique by the language's rules, and moving the statement or
 * renaming the part keeps it. The host learns it from the module's exports
 * once the module evaluated and hands it over ({@link bind}, through
 * `PartDefinition.bindExport`) before it builds any body.
 *
 * A part with no binding — not exported, exported as `default`, declared
 * inside another body, or whose body already built while the module was
 * still evaluating — falls back to its name and the order the file created
 * its parts of that name: `Plate#1`, `Plate#2`. A binding is an identifier
 * and never holds a `#`, so a fallback never equals one. A fallback follows
 * creation order, so reordering two unexported parts of one name swaps them.
 *
 * The identity is fixed the first time it is read — the definition's first
 * body build — so every variant of one definition in a render shares it.
 */
export class PartIdentity {

  /** Export names the host bound before the identity was fixed. */
  private readonly bindings: string[] = [];
  private fixed: string | null = null;

  constructor(
    /** The `part()` call's name — the part's label. */
    readonly name: string,
    /** 1-based place among the parts of this name its file created. */
    readonly ordinal: number,
  ) {}

  /**
   * Name the definition by an export binding of its module. Ignored once
   * the identity is fixed (a body built before the host bound it keeps its
   * fallback for the whole render) and for `default`, which names no
   * binding. A definition exported under several names takes the first in
   * code-unit order, whatever order the host lists them in.
   */
  bind(exportName: string): void {
    if (this.fixed !== null || exportName === 'default' || exportName === '' || this.bindings.includes(exportName)) {
      return;
    }
    this.bindings.push(exportName);
  }

  /** The identity, fixed on first read: the binding, else the {@link fallback}. */
  get id(): string {
    if (this.fixed === null) {
      this.fixed = this.bindings.length > 0
        ? this.bindings.slice().sort()[0]
        : PartIdentity.fallback(this.name, this.ordinal);
    }
    return this.fixed;
  }

  /** The identity of the `ordinal`-th unbound part named `name`: `Plate#2`. */
  static fallback(name: string, ordinal: number): string {
    return `${name}#${ordinal}`;
  }

  /** Whether an identity is a fallback (`Name#n`) rather than a binding. */
  static isFallback(id: string): boolean {
    return /#\d+$/.test(id);
  }

  /**
   * What tells a body apart from another of the same name: its binding, or
   * `#n` for a fallback (`Plate#2` → `#2`).
   */
  static tag(id: string): string {
    const match = /#\d+$/.exec(id);
    return match ? match[0] : id;
  }

  /**
   * How a body is named to a person: its name, with its {@link tag} in
   * parentheses when another body of the file has the same name —
   * `Plate (lid)`, `Plate (#2)`.
   */
  static label(name: string, id: string, shared: boolean): string {
    return shared ? `${name} (${PartIdentity.tag(id)})` : name;
  }
}

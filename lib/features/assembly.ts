/**
 * A lazy sub-assembly definition created by `assembly(name, callback)`.
 *
 * Nothing runs at definition time — each `insert(definition)` executes the
 * callback under a fresh occurrence scope, so the instance/occurrence handles
 * the callback returns are naturally per-occurrence and the same definition
 * value can be inserted any number of times. (Deliberately asymmetric with
 * `part()`, which builds eagerly: part geometry is identical across
 * instances, while an assembly body creates per-occurrence records.)
 *
 * Detected by duck-typed `getType() === 'assembly'` (like Part's
 * `getType() === 'part'`) so the server's catalog scanner recognizes
 * definitions across fluidcad module copies.
 */
export class Assembly<T = unknown> {
  constructor(
    public readonly assemblyName: string,
    private readonly callback: () => T,
  ) {}

  getType(): string {
    return "assembly";
  }

  /** Execute the definition body. `insert()` calls this inside the occurrence's scope. */
  run(): T {
    return this.callback();
  }
}

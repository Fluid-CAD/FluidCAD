/**
 * Error thrown by feature pre-build validation when an operand or input is
 * unsuitable for the operation. Carries an optional hint so the user can be
 * told both what went wrong and how to fix it.
 *
 * Extends Error so the renderer's existing try/catch in `buildObject` and
 * `describeError` keep working unchanged.
 */
export class BuildError extends Error {
  constructor(public readonly diagnostic: string, public readonly hint?: string) {
    super(hint ? `${diagnostic}\nHint: ${hint}` : diagnostic);
    this.name = 'BuildError';
  }
}

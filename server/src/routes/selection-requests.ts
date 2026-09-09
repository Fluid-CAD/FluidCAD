import type { SelectionScopeInput } from '../../../lib/dist/index.js';

const MAX_EXPRESSION_LENGTH = 4000;

/**
 * Body validation for the requests that carry a filter expression —
 * `/resolve-selection` and the filter form of `/measure` entities — and the
 * HTTP status each resolver failure maps to, so both routes refuse the same
 * way.
 */
export class SelectionRequests {

  /** The error naming what is wrong with `expression`, or null when it is usable. */
  static expressionError(expression: unknown, label = 'expression'): string | null {
    if (typeof expression !== 'string' || expression.trim().length === 0) {
      return `${label} must be a non-empty string of FluidCAD filter syntax, e.g. face().onPlane("xy", 10)`;
    }
    if (expression.length > MAX_EXPRESSION_LENGTH) {
      return `${label} is longer than ${MAX_EXPRESSION_LENGTH} characters`;
    }
    return null;
  }

  /**
   * The error naming what is wrong with `scope`, or null when it is absent or
   * one of `{ sceneObjectId }`, `{ part }`, `{ instanceId }` with a non-empty
   * string value.
   */
  static scopeError(scope: unknown, label = 'scope'): string | null {
    if (scope === undefined) {
      return null;
    }
    if (typeof scope !== 'object' || scope === null || Array.isArray(scope)) {
      return `${label} must be an object: { sceneObjectId } | { part } | { instanceId }`;
    }
    const keys = Object.keys(scope);
    const known = ['sceneObjectId', 'part', 'instanceId'];
    const given = keys.filter(k => known.includes(k));
    if (given.length !== 1 || keys.length !== 1) {
      return `${label} needs exactly one of sceneObjectId, part or instanceId`;
    }
    const value = (scope as Record<string, unknown>)[given[0]];
    if (typeof value !== 'string' || value.length === 0) {
      return `${label}.${given[0]} must be a non-empty string`;
    }
    return null;
  }

  static asScope(scope: unknown): SelectionScopeInput | undefined {
    if (scope === undefined) {
      return undefined;
    }
    return scope as SelectionScopeInput;
  }

  /** HTTP status for a resolver refusal: the caller named something that does not exist, is ambiguous, or does not evaluate. */
  static statusFor(code: string): number {
    switch (code) {
      case 'no-scene':
      case 'unknown-scope':
      case 'no-match':
        return 404;
      case 'ambiguous-scope':
      case 'ambiguous-match':
        return 409;
      case 'unsupported':
        return 501;
      default:
        return 422;
    }
  }
}

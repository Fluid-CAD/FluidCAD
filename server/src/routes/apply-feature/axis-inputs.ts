// One axis slot's request input as every axis-taking route reads it.

import type { ApplyFeatureEditSpec, ConnectorAxisSpec } from '../../apply-feature-edit/index.ts';
import type { RevolveAxisInput } from './validate/revolve.ts';

/** An axis input as its spec form, before a picked edge is synthesized. */
export type BoundAxisSpec =
  | { kind: 'standard'; axis: 'x' | 'y' | 'z' }
  | { kind: 'axis'; producer: number }
  | ConnectorAxisSpec;

/**
 * The axis inputs every axis slot sends — revolve, helix, repeat, rotate,
 * copy — read one way: a world axis as it is, an `axis()` statement bound
 * to a variable, a connector bound under its own name (its Z axis through
 * its origin; `.instance(<slot>)` for one of its copies), a picked edge left
 * to the route's synthesis.
 */
export class AxisInputs {
  /**
   * The file the statement an axis input names lives in — an `axis()`
   * statement's, or a connector's; null for a world axis or a picked edge,
   * whose file the synthesis answers.
   */
  static fileOf(input: RevolveAxisInput): string | null {
    return input.kind === 'axis' || input.kind === 'connector' ? input.loc.filePath : null;
  }

  /**
   * The spec for an input that names no edge (a picked edge is the
   * caller's to synthesize): a world axis as it is, an `axis()` statement
   * or a connector bound through `merge`.
   */
  static bind(
    input: Exclude<RevolveAxisInput, { kind: 'edge' }>,
    merge: (producer: ApplyFeatureEditSpec['producers'][number]) => number,
  ): BoundAxisSpec {
    if (input.kind === 'standard') {
      return { kind: 'standard', axis: input.axis };
    }
    if (input.kind === 'axis') {
      return {
        kind: 'axis',
        producer: merge({ line: input.loc.line, column: input.loc.column, featureType: 'axis', nameHint: 'a', bind: true }),
      };
    }
    return {
      kind: 'connector',
      producer: merge({ line: input.loc.line, column: input.loc.column, featureType: 'connector', nameHint: 'c', bind: true }),
      ...(input.slot !== undefined ? { slot: input.slot } : {}),
    };
  }

  /** A merge over a plain producer list — for the routes that push their producers in order. */
  static appender(producers: ApplyFeatureEditSpec['producers']): (producer: ApplyFeatureEditSpec['producers'][number]) => number {
    return (producer) => {
      producers.push(producer);
      return producers.length - 1;
    };
  }
}

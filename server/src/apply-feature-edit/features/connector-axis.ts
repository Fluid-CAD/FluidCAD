// A connector standing for an axis: the spec every axis slot shares, its rendering and its check.

import { isConnectorProducer } from '../producers/predicates.ts';
import type { ApplyFeatureEditSpec } from '../spec.ts';

/**
 * An axis that is a connector — its Z axis through its origin, as the
 * engine reads it (`resolveAxis`): its `connector()` statement bound under
 * the connector's own name (a `connector` producer), and `.instance(<slot>)`
 * on it for one of its copies (`bolt.instance(2)`). Every axis slot takes
 * one — revolve, helix, repeat, rotate, copy — alongside its world axis,
 * axis statement and picked edge.
 */
export type ConnectorAxisSpec = { kind: 'connector'; producer: number; slot?: number };

/** The connector axis's rendering and check, shared by every axis spec. */
export class ConnectorAxisSpecs {
  /**
   * `bolt`, or `bolt.instance(2)` for a copy. Shared with the routes'
   * previews, which pass their namer's variables; the transform passes its
   * bindings'.
   */
  static render(axis: ConnectorAxisSpec, varFor: (producer: number) => string | null): string {
    const binding = varFor(axis.producer) ?? 'c';
    return axis.slot === undefined ? binding : `${binding}.instance(${axis.slot})`;
  }

  /** A copy's slot is a non-negative whole number; absent names the connector itself. */
  static validSlot(slot: unknown): boolean {
    return slot === undefined || (Number.isSafeInteger(slot) && (slot as number) >= 0);
  }

  /** Whether the spec binds the axis's connector as one, at a valid slot. */
  static valid(spec: Pick<ApplyFeatureEditSpec, 'producers'>, axis: ConnectorAxisSpec): boolean {
    return isConnectorProducer(spec as ApplyFeatureEditSpec, axis.producer) && ConnectorAxisSpecs.validSlot(axis.slot);
  }
}

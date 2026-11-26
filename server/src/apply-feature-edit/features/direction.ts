// A direction: the spec every direction slot shares, its rendering and its check.

import { isAxisProducer, isPlaneProducer } from '../producers/predicates.ts';
import { renderSelectorPartExpr } from '../render/selectors.ts';
import type { ApplyFeatureEditSpec } from '../spec.ts';
import { ConnectorAxisSpecs, type ConnectorAxisSpec } from './connector-axis.ts';

/**
 * One direction, as a tool's `.direction(…)` takes it: given the way an axis
 * is given everywhere else, or as a plane, which stands for its normal.
 *
 * - a world axis or an origin plane: its string literal, no producer;
 * - an `axis()` or a `plane()` statement, bound to a variable;
 * - a connector ({@link ConnectorAxisSpec}): its Z axis;
 * - a picked straight edge or planar face: the selector a `parts` entry
 *   renders (`part`, the first when absent), written bare — the engine reads
 *   an edge by its own direction and a face by its normal.
 */
export type DirectionSpec =
  | { kind: 'standard'; axis: 'x' | 'y' | 'z' }
  | { kind: 'standard-plane'; plane: 'xy' | 'xz' | 'yz' }
  | { kind: 'axis'; producer: number }
  | { kind: 'plane'; producer: number }
  | ConnectorAxisSpec
  | { kind: 'edge'; part?: number }
  | { kind: 'face'; part?: number };

/** The producers and selector parts a direction indexes into. */
type DirectionHost = Pick<ApplyFeatureEditSpec, 'producers' | 'parts'>;

/** A direction's rendering and check, shared by every statement that takes one. */
export class Directions {
  /**
   * The direction as an expression: `'z'`, `'xy'`, the bound variable of an
   * axis or a plane statement (`a`, `p`), a connector (`bolt`,
   * `bolt.instance(2)`), or the picked edge's or face's selector. Shared
   * with the routes' previews, which pass their namer's variables; the
   * transform passes its bindings'.
   */
  static render(
    direction: DirectionSpec,
    parts: ApplyFeatureEditSpec['parts'],
    varFor: (producer: number) => string | null,
  ): string {
    if (direction.kind === 'standard') {
      return `'${direction.axis}'`;
    }
    if (direction.kind === 'standard-plane') {
      return `'${direction.plane}'`;
    }
    if (direction.kind === 'axis') {
      return varFor(direction.producer) ?? 'a';
    }
    if (direction.kind === 'plane') {
      return varFor(direction.producer) ?? 'p';
    }
    if (direction.kind === 'connector') {
      return ConnectorAxisSpecs.render(direction, varFor);
    }
    const part = parts[direction.part ?? 0];
    return renderSelectorPartExpr(part, part.producer === null ? null : varFor(part.producer), varFor);
  }

  /**
   * Reads `value` as a direction of `spec`: one of the kinds, a world axis
   * or origin plane by a known name, a statement by a bound producer of its
   * kind, a picked edge or face by a selector part the spec holds. `label`
   * names the slot in the refusal (`source`, for a helix).
   */
  static validate(value: unknown, spec: DirectionHost, label = 'direction'): DirectionSpec | { error: string } {
    const raw = value as { kind?: unknown; axis?: unknown; plane?: unknown; producer?: unknown; slot?: unknown; part?: unknown } | null;
    if (raw?.kind === 'standard') {
      return raw.axis === 'x' || raw.axis === 'y' || raw.axis === 'z'
        ? { kind: 'standard', axis: raw.axis }
        : { error: 'bad standard axis' };
    }
    if (raw?.kind === 'standard-plane') {
      return raw.plane === 'xy' || raw.plane === 'xz' || raw.plane === 'yz'
        ? { kind: 'standard-plane', plane: raw.plane }
        : { error: 'bad standard plane' };
    }
    if (raw?.kind === 'axis') {
      return isAxisProducer(spec as ApplyFeatureEditSpec, raw.producer as number)
        ? { kind: 'axis', producer: raw.producer as number }
        : { error: `the ${label} references a non-axis producer` };
    }
    if (raw?.kind === 'plane') {
      return isPlaneProducer(spec as ApplyFeatureEditSpec, raw.producer as number)
        ? { kind: 'plane', producer: raw.producer as number }
        : { error: `the ${label} references a non-plane producer` };
    }
    if (raw?.kind === 'connector') {
      const connector = { kind: 'connector' as const, producer: raw.producer as number, slot: raw.slot as number | undefined };
      if (!ConnectorAxisSpecs.valid(spec, connector)) {
        return { error: `the ${label} references a non-connector producer` };
      }
      return connector.slot === undefined ? { kind: 'connector', producer: connector.producer } : connector;
    }
    if (raw?.kind === 'edge' || raw?.kind === 'face') {
      const part = raw.part === undefined ? 0 : raw.part as number;
      if (!Number.isInteger(part) || part < 0 || part >= spec.parts.length) {
        return { error: `the ${label} references no selector part` };
      }
      return raw.part === undefined ? { kind: raw.kind } : { kind: raw.kind, part };
    }
    return { error: `unknown ${label} kind` };
  }
}

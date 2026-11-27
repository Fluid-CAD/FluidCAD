// One direction slot's request input, as every direction-taking route reads it.

import type { ApplyFeatureEditSpec, DirectionSpec } from '../../apply-feature-edit/index.ts';
import { AxisInputs } from './axis-inputs.ts';
import { validateSketchLoc, type SketchLoc } from './locations.ts';
import { validatePick, type Pick } from './picks.ts';
import { validateRevolveAxis, type RevolveAxisInput } from './validate/revolve.ts';

/**
 * One direction on the wire, as the dialog's direction slot sends it
 * (`DirectionSlotControl.value()`): every axis input an axis slot sends — a
 * world axis, an `axis()` statement by call site, a picked edge, a connector
 * (its Z axis; a copy's with its slot) — plus the planes, each standing for
 * its normal: an origin plane, a `plane()` statement by call site, a picked
 * face. A picked edge or face is written as its selector; the engine reads
 * an edge by its own direction and a face by its normal.
 */
export type DirectionInput =
  | RevolveAxisInput
  | { kind: 'standard-plane'; plane: 'xy' | 'xz' | 'yz' }
  | { kind: 'plane'; loc: SketchLoc }
  | { kind: 'face'; pick: Pick };

/** The producer list an arm builds and the merge that folds a statement into it once (see `makeProducerMerger`). */
type ProducerMerge = (producer: ApplyFeatureEditSpec['producers'][number]) => number;

/**
 * The direction inputs of a direction slot: read off a request, and resolved
 * into the {@link DirectionSpec} a statement writes — a literal as it is, a
 * statement bound as a producer, a picked edge or face synthesized into one
 * selector part.
 */
export class DirectionInputs {
  /**
   * Reads `raw` as a direction: an axis input ({@link validateRevolveAxis}),
   * an origin plane, a `plane()` statement by call site, or a picked face.
   * The refusal names the slot.
   */
  static validate(input: any, slot = 'direction'): DirectionInput | { error: string } {
    if (input?.kind === 'standard-plane') {
      return input.plane === 'xy' || input.plane === 'xz' || input.plane === 'yz'
        ? { kind: 'standard-plane', plane: input.plane }
        : { error: `the ${slot}'s origin plane must be "xy", "xz" or "yz"` };
    }
    if (input?.kind === 'plane') {
      const loc = validateSketchLoc(input);
      return loc ? { kind: 'plane', loc } : { error: `the ${slot}'s plane must carry the plane() {filePath, line}` };
    }
    if (input?.kind === 'face') {
      const pick = validatePick(input.entity);
      return pick && pick.sub.type === 'face'
        ? { kind: 'face', pick }
        : { error: `the ${slot}'s face must carry a {shapeId, sub:{type:"face", index}} pick` };
    }
    if (input?.kind === 'standard' || input?.kind === 'axis' || input?.kind === 'edge' || input?.kind === 'connector') {
      return validateRevolveAxis(input);
    }
    return { error: `${slot} must be {kind: "standard"|"axis"|"edge"|"connector"|"standard-plane"|"plane"|"face", …}` };
  }

  /** Whether the input is a picked edge or face — what needs synthesis (and, in an edit, a boundary). */
  static picksGeometry(input: DirectionInput): input is Extract<DirectionInput, { kind: 'edge' | 'face' }> {
    return input.kind === 'edge' || input.kind === 'face';
  }

  /**
   * The call site of the statement the input names — an `axis()`, a
   * `plane()`, a connector — or null for a literal or a picked edge or face,
   * whose file the synthesis answers.
   */
  static statement(input: DirectionInput): SketchLoc | null {
    return input.kind === 'axis' || input.kind === 'connector' || input.kind === 'plane' ? input.loc : null;
  }

  /**
   * The direction the input comes to: a world axis or an origin plane as it
   * is, an `axis()` or a `plane()` statement or a connector bound through
   * `merge`, a picked edge or face synthesized by `synthesize` into the one
   * selector part it writes. `synthesize` answers the indices of the parts it
   * added, or null once it has refused the request; null is passed on, and a
   * pick that comes to anything but one part is refused through `refuse`.
   */
  static async resolve(
    input: DirectionInput,
    merge: ProducerMerge,
    synthesize: (picks: Pick[]) => Promise<number[] | null> | number[] | null,
    refuse: (reason: string) => void,
  ): Promise<DirectionSpec | null> {
    if (input.kind === 'standard-plane') {
      return { kind: 'standard-plane', plane: input.plane };
    }
    if (input.kind === 'plane') {
      return {
        kind: 'plane',
        producer: merge({ line: input.loc.line, column: input.loc.column, featureType: 'plane', nameHint: 'p', bind: true }),
      };
    }
    if (input.kind === 'edge' || input.kind === 'face') {
      const parts = await synthesize([input.pick]);
      if (parts === null) {
        return null;
      }
      // `.direction()` takes ONE scene object — a multi-part selection has
      // no single-expression rendering.
      if (parts.length !== 1) {
        refuse('the direction must be a single edge or face selection');
        return null;
      }
      return { kind: input.kind, part: parts[0] };
    }
    return AxisInputs.bind(input, merge);
  }
}

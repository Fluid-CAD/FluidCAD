// Pick → wire-target mapping for the solved constraint bar (P4), split out
// so the emission shape is testable without the service's scene machinery.
// Loop-instance targeting: a statement inside a loop produces one object per
// iteration, all sharing a source line — the pick's `sourceLocation.occurrence`
// tells the instances apart and must ride every line-addressed target.

import type { SketchConstraintTargetParam } from '../../api';
import type { SourceLocation } from '../../types';
import type { SolvedPick } from '../sketch-hover-select-handler';

/** A pick as an add-constraint wire target: datum picks by name, reference
 * picks (P6) by producer statement + refIndex, copy-duplicate picks by the
 * copy statement + instance slot, entity picks by statement —
 * line-addressed forms carry the pick's loop occurrence when it has one. */
export function constraintTargetFor(p: SolvedPick): SketchConstraintTargetParam {
  if (p.datum !== undefined) {
    // Datum picks (origin/axes) have no source statement — the server
    // renders the accessor call (origin()/xAxis()/yAxis()) instead.
    return { datum: p.datum };
  }
  if (p.copyInstance !== undefined) {
    // Copy-duplicate picks address their copy() statement plus the
    // duplicate's instance() slot; the server renders `c.instance(i)` and
    // hoists an unbound copy like any entity statement.
    return {
      line: p.sourceLocation?.line ?? -1,
      ...(p.sourceLocation?.occurrence !== undefined
        ? { occurrence: p.sourceLocation.occurrence } : {}),
      ...(p.role !== undefined && p.role !== null ? { role: p.role } : {}),
      featureType: 'copy',
      instanceIndex: p.copyInstance.slot,
    };
  }
  if (p.reference !== undefined) {
    // Reference picks (P6) address their producer statement; the server
    // renders `p1.ref(i)` (or the terse single-entity form) and hoists
    // an unbound project()/intersect() like any entity statement.
    return {
      line: p.sourceLocation?.line ?? -1,
      ...(p.sourceLocation?.occurrence !== undefined
        ? { occurrence: p.sourceLocation.occurrence } : {}),
      ...(p.role !== undefined && p.role !== null ? { role: p.role } : {}),
      featureType: p.reference.producer,
      refIndex: p.reference.refIndex,
    };
  }
  return {
    line: p.sourceLocation?.line ?? -1,
    ...(p.sourceLocation?.occurrence !== undefined
      ? { occurrence: p.sourceLocation.occurrence } : {}),
    ...(p.role !== undefined && p.role !== null ? { role: p.role } : {}),
    featureType: p.kind,
  };
}

/** Whether two source locations name the same statement INSTANCE: same line
 * and same loop occurrence (both-undefined matches — single-instance
 * statements carry none). Line-only matching re-anchored a picked looped
 * constraint to the loop's first badge after every re-render. */
export function sameStatementInstance(
  a: SourceLocation | undefined,
  b: SourceLocation | undefined,
): boolean {
  return a !== undefined && b !== undefined
    && a.line === b.line && a.occurrence === b.occurrence;
}

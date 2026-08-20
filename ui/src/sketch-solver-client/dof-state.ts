// Pure mapping from the solved-sketch read model to the DOF pill state —
// kept out of the DOM class so it is unit-testable.

import type { SourceLocation } from '../types';
import type { SolvedSketchModel } from './model';

export type FailedConstraint = { label: string; sourceLocation?: SourceLocation };

export type SketchDofState =
  | { result: 'hidden' }
  | { result: 'conflict'; failed: FailedConstraint[]; redundant: number }
  | { result: 'unsolved'; outcome: 'didnt-converge' | 'singular' }
  | { result: 'constrained'; redundant: number }
  | { result: 'under'; dof: number; redundant: number };

export function computeSketchDofState(model: SolvedSketchModel | null): SketchDofState {
  if (!model || !model.solver || model.entities.size === 0) {
    return { result: 'hidden' };
  }

  if (model.conflictCount > 0) {
    const failed: FailedConstraint[] = [];
    for (const c of model.constraints) {
      if (c.status === 'conflicting') {
        failed.push({ label: statementLabel(c.kind, c.obj.sourceLocation), sourceLocation: c.obj.sourceLocation });
      }
    }
    // Internal (negative-id) conflicts belong to the owning entity's
    // statement — an arc whose consistency rows sit in a conflicting group.
    for (const id of model.solver.conflicting) {
      if (id >= 0) {
        continue;
      }
      const record = model.solver.constraints.find(r => r.id === id);
      const entityId = record && record.spec.kind === 'arc-consistency' ? record.spec.entity : undefined;
      const entity = entityId !== undefined ? model.entities.get(entityId) : undefined;
      if (entity) {
        failed.push({
          label: statementLabel(entity.obj?.name ?? entity.kind, entity.obj?.sourceLocation),
          sourceLocation: entity.obj?.sourceLocation,
        });
      }
    }
    return { result: 'conflict', failed, redundant: model.redundantCount };
  }

  if (model.outcome === 'didnt-converge' || model.outcome === 'singular') {
    return { result: 'unsolved', outcome: model.outcome };
  }

  if (model.dof === 0) {
    return { result: 'constrained', redundant: model.redundantCount };
  }

  return { result: 'under', dof: model.dof ?? 0, redundant: model.redundantCount };
}

function statementLabel(name: string, loc: SourceLocation | undefined): string {
  return loc ? `${name} (line ${loc.line})` : name;
}

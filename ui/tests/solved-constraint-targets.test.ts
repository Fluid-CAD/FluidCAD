import { describe, it, expect } from 'vitest';
import {
  constraintTargetFor,
  sameStatementInstance,
} from '../src/interactive/solved-constraint-toolbar/constraint-targets';
import type { SolvedPick } from '../src/interactive/sketch-hover-select-handler';

// Loop-instance constraint targeting: a looped statement produces one object
// per iteration, all sharing a source line — the pick's occurrence must ride
// every line-addressed wire target, and the picked-constraint re-anchor must
// match by line + occurrence (line-only matching snapped back to badge #1).

const LOC = { filePath: '/w/part.fluid.js', line: 12, column: 3 };

describe('constraintTargetFor', () => {
  it('maps an entity pick to a line-addressed target', () => {
    const pick: SolvedPick = { entityId: 0, kind: 'line', role: 'end', sourceLocation: LOC };
    expect(constraintTargetFor(pick)).toEqual({ line: 12, role: 'end', featureType: 'line' });
  });

  it('carries the pick\'s loop occurrence on entity targets', () => {
    const pick: SolvedPick = {
      entityId: 3, kind: 'circle', role: 'center',
      sourceLocation: { ...LOC, occurrence: 2 },
    };
    expect(constraintTargetFor(pick))
      .toEqual({ line: 12, occurrence: 2, role: 'center', featureType: 'circle' });
  });

  it('carries occurrence 0 (a real index, not a falsy nothing)', () => {
    const pick: SolvedPick = {
      entityId: 3, kind: 'line', sourceLocation: { ...LOC, occurrence: 0 },
    };
    expect(constraintTargetFor(pick))
      .toEqual({ line: 12, occurrence: 0, featureType: 'line' });
  });

  it('carries occurrence on reference (P6) targets', () => {
    const pick: SolvedPick = {
      entityId: 5, kind: 'line',
      sourceLocation: { ...LOC, occurrence: 1 },
      reference: { refIndex: 2, producer: 'project' },
    };
    expect(constraintTargetFor(pick))
      .toEqual({ line: 12, occurrence: 1, featureType: 'project', refIndex: 2 });
  });

  it('never puts occurrence on datum targets', () => {
    const pick: SolvedPick = { entityId: -1, kind: 'point', datum: 'origin' };
    expect(constraintTargetFor(pick)).toEqual({ datum: 'origin' });
  });

  it('maps a copy-duplicate pick to the copy statement + instance slot', () => {
    const pick: SolvedPick = {
      entityId: 5, kind: 'line', sourceLocation: LOC, copyInstance: { slot: 2 },
    };
    expect(constraintTargetFor(pick))
      .toEqual({ line: 12, featureType: 'copy', instanceIndex: 2 });
  });

  it('maps an ellipse-center anchor pick to a featureType-only target (P8)', () => {
    const pick: SolvedPick = {
      entityId: 4, kind: 'point', role: null, sourceLocation: LOC,
      anchor: { owner: 'ellipse', pointIndex: 0 },
    };
    expect(constraintTargetFor(pick)).toEqual({ line: 12, featureType: 'ellipse' });
  });

  it('maps a text-anchor pick without a role or index', () => {
    const pick: SolvedPick = {
      entityId: 6, kind: 'point', role: null, sourceLocation: LOC,
      anchor: { owner: 'text', pointIndex: 0 },
    };
    expect(constraintTargetFor(pick)).toEqual({ line: 12, featureType: 'text' });
  });

  it('carries the control-point index on bezier anchor picks, plus loop occurrence', () => {
    const pick: SolvedPick = {
      entityId: 7, kind: 'point', role: null,
      sourceLocation: { ...LOC, occurrence: 1 },
      anchor: { owner: 'bezier', pointIndex: 2 },
    };
    expect(constraintTargetFor(pick))
      .toEqual({ line: 12, occurrence: 1, featureType: 'bezier', pointIndex: 2 });
  });

  it('carries role on copy-duplicate targets', () => {
    const pick: SolvedPick = {
      entityId: 5, kind: 'line', role: 'end', sourceLocation: LOC, copyInstance: { slot: 1 },
    };
    expect(constraintTargetFor(pick))
      .toEqual({ line: 12, role: 'end', featureType: 'copy', instanceIndex: 1 });
  });

  it('carries occurrence on copy-duplicate targets (copy inside a loop)', () => {
    const pick: SolvedPick = {
      entityId: 6, kind: 'circle',
      sourceLocation: { ...LOC, occurrence: 3 },
      copyInstance: { slot: 4 },
    };
    expect(constraintTargetFor(pick))
      .toEqual({ line: 12, occurrence: 3, featureType: 'copy', instanceIndex: 4 });
  });
});

describe('sameStatementInstance (picked-constraint re-anchor)', () => {
  it('matches same line with both occurrences undefined', () => {
    expect(sameStatementInstance(LOC, { ...LOC })).toBe(true);
  });

  it('separates instances of one looped statement', () => {
    expect(sameStatementInstance({ ...LOC, occurrence: 0 }, { ...LOC, occurrence: 1 })).toBe(false);
    expect(sameStatementInstance({ ...LOC, occurrence: 1 }, { ...LOC, occurrence: 1 })).toBe(true);
    // A loop instance never matches a single-instance record of the line.
    expect(sameStatementInstance({ ...LOC, occurrence: 0 }, LOC)).toBe(false);
  });

  it('never matches through a missing location', () => {
    expect(sameStatementInstance(undefined, LOC)).toBe(false);
    expect(sameStatementInstance(LOC, undefined)).toBe(false);
  });
});

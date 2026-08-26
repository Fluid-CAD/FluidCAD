// Pure builder of the batch position write-back payload (sketch-rewrite
// P4). After a drag's final solve, every entity whose current geometry
// drifted from its statement-time literals (beyond 2dp resolution) yields
// one edit against its statement: the drifted point args, addressed by
// chain-point index, guarded by the expected source values.

import type { SketchPositionEditParam } from '../api';
import type { LiveEntityGeometry } from './live-system';
import type { SolvedEntityView, SolvedSketchModel } from './model';

/** Half a 2dp step: drift below this cannot change the written literal. */
const WRITE_TOL = 0.005;

const round2 = (v: number): number => Math.round(v * 100) / 100;

type RoleName = 'point' | 'start' | 'end' | 'center';

/** Chain-point-arg index of each role per statement form:
 * point([p]) / line([s], [e]) / arc([s], [e], [c]) / circle([c], d). */
const ROLE_INDEX: Record<SolvedEntityView['kind'], Partial<Record<RoleName, number>>> = {
  point: { point: 0 },
  line: { start: 0, end: 1 },
  arc: { start: 0, end: 1, center: 2 },
  circle: { center: 0 },
};

function drifted(current: [number, number], guess: [number, number]): boolean {
  return Math.abs(current[0] - guess[0]) >= WRITE_TOL
    || Math.abs(current[1] - guess[1]) >= WRITE_TOL;
}

/**
 * The write-back payload for one drag, plus the target file. Entities
 * without a source location or guess payload (or fixed reference geometry,
 * whose params never move) contribute nothing.
 */
export function buildPositionWriteBack(
  model: SolvedSketchModel,
  read: (entityId: number) => LiveEntityGeometry | null,
): { edits: SketchPositionEditParam[]; filePath?: string } {
  const edits: SketchPositionEditParam[] = [];
  let filePath: string | undefined;

  for (const [entityId, view] of model.entities) {
    const loc = view.obj?.sourceLocation;
    const guess = view.guess;
    if (!loc || !guess) {
      continue;
    }
    const g = read(entityId);
    if (!g) {
      continue;
    }

    const points: NonNullable<SketchPositionEditParam['points']> = [];
    const roles: [RoleName, [number, number] | undefined][] = [
      ['point', g.point],
      ['start', g.start],
      ['end', g.end],
      ['center', g.center],
    ];
    for (const [role, current] of roles) {
      // Anchor points (ellipse center / text anchor / bezier control
      // point) address the owning statement's chain point arg directly —
      // a bezier's i-th literal is its i-th point-like argument.
      const index = view.anchor && role === 'point'
        ? view.anchor.pointIndex
        : ROLE_INDEX[view.kind][role];
      const expected = guess[role];
      if (index === undefined || !current || !expected) {
        continue;
      }
      if (drifted(current, expected)) {
        points.push({
          pointIndex: index,
          position: [round2(current[0]), round2(current[1])],
          expected,
        });
      }
    }

    const edit: SketchPositionEditParam = { sourceLine: loc.line };
    if (points.length > 0) {
      edit.points = points;
    }
    if (view.kind === 'circle' && g.radius !== undefined && guess.diameter !== undefined
      && Math.abs(g.radius * 2 - guess.diameter) >= WRITE_TOL) {
      edit.scalar = { value: round2(g.radius * 2), expected: guess.diameter };
    }

    if (edit.points || edit.scalar) {
      edits.push(edit);
      filePath = filePath ?? loc.filePath;
    }
  }

  return { edits, filePath };
}

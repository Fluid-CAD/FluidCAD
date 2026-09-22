// Pure builder of the batch position write-back payload (sketch-rewrite
// P4). After a drag's final solve, every entity whose current geometry
// drifted from its statement-time literals (beyond 2dp resolution) yields
// one edit against its statement: the drifted point args, addressed by
// chain-point index, guarded by the expected source values — plus the
// solved scalars a statement carries as literals: a circle's diameter, an
// ellipse's semi-radii and rotation.

import type { SketchPositionEditParam } from '../api';
import type { LiveEntityGeometry } from './live-system';
import type { SolvedEntityView, SolvedSketchModel } from './model';

/** Half a 2dp step: drift below this cannot change the written literal. */
const WRITE_TOL = 0.005;

const round2 = (v: number): number => Math.round(v * 100) / 100;

type RoleName = 'point' | 'start' | 'end' | 'center';

/** Chain-point-arg index of each role per statement form:
 * point([p]) / line([s], [e]) / arc([s], [e], [c]) / circle([c], d) /
 * ellipse([c], rx, ry, rotation). */
const ROLE_INDEX: Record<SolvedEntityView['kind'], Partial<Record<RoleName, number>>> = {
  point: { point: 0 },
  line: { start: 0, end: 1 },
  arc: { start: 0, end: 1, center: 2 },
  circle: { center: 0 },
  ellipse: { center: 0 },
};

/** An ellipse is the same shape every 180°: the drift of a solved rotation
 * from the written one is read modulo 180, in (−90, 90]. */
function wrap180(deg: number): number {
  let r = deg % 180;
  if (r > 90) {
    r -= 180;
  }
  if (r <= -90) {
    r += 180;
  }
  return r;
}

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
  // One edit per STATEMENT, keyed by source line: a bezier's control points
  // are separate anchor entities that all address the same statement, and
  // the server refuses a batch that names a line twice.
  const editsByLine = new Map<number, SketchPositionEditParam>();
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
      // Anchor points (text anchor / bezier control point) address the
      // owning statement's chain point arg directly — a bezier's i-th
      // literal is its i-th point-like argument.
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
    // An ellipse's semi-radii: the 2nd and 3rd arguments, like a circle's
    // diameter — solver params the dimensions drive.
    if (view.kind === 'ellipse' && g.radii && guess.rx !== undefined && guess.ry !== undefined) {
      const radii: NonNullable<SketchPositionEditParam['radii']> = {};
      if (Math.abs(g.radii[0] - guess.rx) >= WRITE_TOL) {
        radii.rx = { value: round2(g.radii[0]), expected: guess.rx };
      }
      if (Math.abs(g.radii[1] - guess.ry) >= WRITE_TOL) {
        radii.ry = { value: round2(g.radii[1]), expected: guess.ry };
      }
      if (radii.rx || radii.ry) {
        edit.radii = radii;
      }
    }
    // An ellipse's rotation: the 4th argument, appended when the statement
    // has none yet (`expected` absent). Written as the value nearest the
    // literal, so a rotation the solve left alone never churns the source.
    if (view.kind === 'ellipse' && g.theta !== undefined) {
      const written = guess.rotation ?? 0;
      const drift = wrap180((g.theta * 180) / Math.PI - written);
      if (Math.abs(drift) >= WRITE_TOL) {
        edit.rotation = {
          value: round2(written + drift),
          ...(guess.rotation !== undefined ? { expected: guess.rotation } : {}),
        };
      }
    }

    if (edit.points || edit.scalar || edit.radii || edit.rotation) {
      mergeEdit(editsByLine, edit);
      filePath = filePath ?? loc.filePath;
    }
  }

  return { edits: [...editsByLine.values()], filePath };
}

/** Fold `edit` into the statement edit already collected for its line, if
 * any: point edits append (distinct chain-point indices per entity), the
 * scalar slots are owned by a single entity each and simply carry over. */
function mergeEdit(editsByLine: Map<number, SketchPositionEditParam>, edit: SketchPositionEditParam): void {
  const existing = editsByLine.get(edit.sourceLine);
  if (!existing) {
    editsByLine.set(edit.sourceLine, edit);
    return;
  }
  if (edit.points) {
    existing.points = [...(existing.points ?? []), ...edit.points];
  }
  if (edit.scalar) {
    existing.scalar = edit.scalar;
  }
  if (edit.radii) {
    existing.radii = edit.radii;
  }
  if (edit.rotation) {
    existing.rotation = edit.rotation;
  }
}

// Writing dragged sketch positions back into the point literals of a solved sketch.

import { applySpliceEdits, splitLines, type SpliceEdit } from './lines.ts';
import {
  callFunctionName,
  chainBaseCall,
  findEditableCallAt,
  findNonArrayArgFromEnd,
  getArgumentsNode,
  numericLiteralValue,
} from './nodes.ts';
import { getParser } from './parser.ts';
import { collectChainPointArgs, parsePointLiteral, roundCoord } from './points.ts';

// ---------------------------------------------------------------------------
// Solved-sketch batch position write-back (sketch-rewrite P4)
// ---------------------------------------------------------------------------

export type SketchPositionPointEdit = {
  /** Index into the statement's chain point args (collectChainPointArgs). */
  pointIndex: number;
  position: [number, number];
  /** The literal's statement-time value from the render payload. A mismatch
   * means the buffer changed since the drag's render — refuse everything. */
  expected?: [number, number];
};

export type SketchPositionEdit = {
  sourceLine: number;
  points?: SketchPositionPointEdit[];
  /** Scalar dimension of the base call (circle diameter), same guard. */
  scalar?: { value: number; expected?: number };
  /** An ellipse's semi-radii — the 2nd / 3rd arguments of
   * `ellipse(center, rx, ry[, rotation])`, same drift guard each. */
  radii?: { rx?: { value: number; expected?: number }; ry?: { value: number; expected?: number } };
  /** An ellipse's rotation (degrees) — the trailing 4th argument of
   * `ellipse(center, rx, ry[, rotation])`: rewritten when present (same
   * drift guard), appended when the statement carries only the three. */
  rotation?: { value: number; expected?: number };
};

/** Non-array arguments of an ellipse() base call beyond which the trailing
 * one is its rotation. */
const ELLIPSE_SCALAR_ARGS = 2;

export type SketchPositionsResult = { newCode: string; error?: string };

/** Statement-time literals are echoed back verbatim through the payload, so
 * agreement is float-exact; the tolerance only absorbs JSON round-tripping. */
const POSITION_DRIFT_TOL = 1e-6;

/**
 * Splice every drifted literal of a solved-sketch drag across multiple
 * statements in ONE parse and ONE edit (one buffer write, one undo step in
 * both editor hosts). All-or-nothing: any drifted or unresolvable statement
 * refuses the whole batch with the offending line named. Non-literal point
 * slots (accessors, identifiers, expressions) are skipped silently — they
 * are solver-derived and the re-solve re-derives them from the spliced
 * literals.
 */
export async function updateSketchPositions(
  code: string,
  edits: SketchPositionEdit[],
): Promise<SketchPositionsResult> {
  const p = await getParser();
  const tree = p.parse(code);
  const lines = splitLines(code);
  const splices: SpliceEdit[] = [];
  const seenLines = new Set<number>();

  for (const edit of edits) {
    if (seenLines.has(edit.sourceLine)) {
      return { newCode: code, error: `duplicate position edit for line ${edit.sourceLine}` };
    }
    seenLines.add(edit.sourceLine);

    const call = findEditableCallAt(tree, lines, edit.sourceLine);
    if (!call) {
      return {
        newCode: code,
        error: `no editable statement at line ${edit.sourceLine} — the source changed since this drag started`,
      };
    }

    const pointArgs = collectChainPointArgs(call);
    for (const point of edit.points ?? []) {
      const idx = point.pointIndex >= 0 ? point.pointIndex : pointArgs.length + point.pointIndex;
      if (idx < 0 || idx >= pointArgs.length) {
        return {
          newCode: code,
          error: `line ${edit.sourceLine} has no point argument ${point.pointIndex} — the source changed since this drag started`,
        };
      }
      const node = pointArgs[idx];
      const current = parsePointLiteral(node);
      if (current === null) {
        continue;
      }
      if (point.expected
        && (Math.abs(current[0] - point.expected[0]) > POSITION_DRIFT_TOL
          || Math.abs(current[1] - point.expected[1]) > POSITION_DRIFT_TOL)) {
        return {
          newCode: code,
          error: `line ${edit.sourceLine} changed since this drag started`
            + ` — expected [${point.expected[0]}, ${point.expected[1]}], found [${current[0]}, ${current[1]}]`,
        };
      }
      splices.push({
        start: node.startIndex,
        end: node.endIndex,
        text: `[${roundCoord(point.position[0])}, ${roundCoord(point.position[1])}]`,
      });
    }

    if (edit.scalar) {
      const baseArgs = getArgumentsNode(chainBaseCall(call));
      const target = baseArgs ? findNonArrayArgFromEnd(baseArgs) : null;
      const current = target ? numericLiteralValue(target) : null;
      if (target && current !== null) {
        if (edit.scalar.expected !== undefined
          && Math.abs(current - edit.scalar.expected) > POSITION_DRIFT_TOL) {
          return {
            newCode: code,
            error: `line ${edit.sourceLine} changed since this drag started`
              + ` — expected ${edit.scalar.expected}, found ${current}`,
          };
        }
        splices.push({
          start: target.startIndex,
          end: target.endIndex,
          text: String(roundCoord(edit.scalar.value)),
        });
      }
    }

    if (edit.radii) {
      const base = chainBaseCall(call);
      const baseArgs = getArgumentsNode(base);
      if (callFunctionName(base) !== 'ellipse' || !baseArgs) {
        return {
          newCode: code,
          error: `line ${edit.sourceLine} is not an ellipse() statement — the source changed since this drag started`,
        };
      }
      const scalars = baseArgs.namedChildren.filter(n => n.type !== 'array');
      const slots: [number, { value: number; expected?: number } | undefined, string][] = [
        [0, edit.radii.rx, 'rx'],
        [1, edit.radii.ry, 'ry'],
      ];
      for (const [index, change, name] of slots) {
        if (!change) {
          continue;
        }
        const target = scalars[index];
        const current = target ? numericLiteralValue(target) : null;
        if (!target || current === null) {
          // An expression or variable (`rx / 2`, `w`) is solver-derived —
          // left alone, like a non-literal point slot.
          continue;
        }
        if (change.expected !== undefined && Math.abs(current - change.expected) > POSITION_DRIFT_TOL) {
          return {
            newCode: code,
            error: `line ${edit.sourceLine} changed since this drag started`
              + ` — expected ${name} ${change.expected}, found ${current}`,
          };
        }
        splices.push({ start: target.startIndex, end: target.endIndex, text: String(roundCoord(change.value)) });
      }
    }

    if (edit.rotation) {
      const base = chainBaseCall(call);
      const baseArgs = getArgumentsNode(base);
      if (callFunctionName(base) !== 'ellipse' || !baseArgs) {
        return {
          newCode: code,
          error: `line ${edit.sourceLine} is not an ellipse() statement — the source changed since this drag started`,
        };
      }
      const scalars = baseArgs.namedChildren.filter(n => n.type !== 'array');
      if (scalars.length > ELLIPSE_SCALAR_ARGS) {
        // Rewrite the existing rotation argument, drift-guarded like the
        // circle's diameter. A non-literal (expression, variable) is left
        // alone — the re-solve re-derives the pose from it.
        const target = scalars[scalars.length - 1];
        const current = numericLiteralValue(target);
        if (current !== null) {
          if (edit.rotation.expected !== undefined
            && Math.abs(current - edit.rotation.expected) > POSITION_DRIFT_TOL) {
            return {
              newCode: code,
              error: `line ${edit.sourceLine} changed since this drag started`
                + ` — expected rotation ${edit.rotation.expected}, found ${current}`,
            };
          }
          splices.push({
            start: target.startIndex,
            end: target.endIndex,
            text: String(roundCoord(edit.rotation.value)),
          });
        }
      } else if (scalars.length === ELLIPSE_SCALAR_ARGS) {
        if (edit.rotation.expected !== undefined) {
          return {
            newCode: code,
            error: `line ${edit.sourceLine} changed since this drag started — its rotation argument is gone`,
          };
        }
        const last = baseArgs.namedChildren[baseArgs.namedChildren.length - 1];
        splices.push({
          start: last.endIndex,
          end: last.endIndex,
          text: `, ${roundCoord(edit.rotation.value)}`,
        });
      }
    }
  }

  return { newCode: applySpliceEdits(code, splices) };
}

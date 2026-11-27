// One curve or surface operand row's request input, as every operand-taking route reads it.

import type { ApplyFeatureEditSpec, OperandPick } from '../../apply-feature-edit/index.ts';
import { normalizePath } from '../../normalize-path.ts';
import type { Pick } from './picks.ts';

/**
 * One pick of a curve or surface operand row on the wire, as the dialog's
 * row holds it (`OperandSlotControl.picks()`): a whole object by its
 * statement's call site — a surface in a surface row, a sketch or a curve in
 * a curve row — or an edge (a curve row) or a face (a surface row) of a body
 * by its viewport address. The preview takes the same list
 * (`GhostOperandRef`, the column aside), so a dialog sends one list to both.
 */
export type OperandInput =
  | { kind: 'statement'; filePath: string; line: number; column: number }
  | { kind: 'edge' | 'face'; shapeId: string; index: number };

/** What each kind of row takes, as a refusal says it. */
const TAKES = { curve: 'curves and edges', surface: 'surfaces and faces' } as const;

/** The producer list an arm builds and the merge that folds a statement into it once (see `makeProducerMerger`). */
type ProducerMerger = {
  producers: ApplyFeatureEditSpec['producers'];
  merge: (producer: ApplyFeatureEditSpec['producers'][number]) => number;
};

/**
 * The picks of a curve or surface operand row: read off a request, and
 * resolved into the {@link OperandPick}s a statement writes — whole objects
 * bound as producers, edges and faces synthesized into selector parts.
 */
export class OperandInputs {
  /**
   * Reads `raw` as the picks of the row `slot`: a non-empty list, each a
   * statement by call site or an entity of the row's kind. The refusal
   * names the slot.
   */
  static validate(raw: unknown, kind: 'curve' | 'surface', slot: string): OperandInput[] | { error: string } {
    const entity = kind === 'curve' ? 'edge' : 'face';
    if (!Array.isArray(raw) || raw.length === 0) {
      return {
        error: `${slot} must be a non-empty list of picks: {kind: "statement", filePath, line, column} or {kind: "${entity}", shapeId, index}`,
      };
    }
    const inputs: OperandInput[] = [];
    for (const pick of raw as { kind?: unknown; filePath?: unknown; line?: unknown; column?: unknown; shapeId?: unknown; index?: unknown }[]) {
      if (pick?.kind === 'statement') {
        if (typeof pick.filePath !== 'string' || pick.filePath.length === 0
          || !Number.isInteger(pick.line) || (pick.line as number) < 1) {
          return { error: `${slot} holds a statement pick without its {filePath, line, column}` };
        }
        const column = Number.isInteger(pick.column) && (pick.column as number) >= 0 ? pick.column as number : 0;
        inputs.push({ kind: 'statement', filePath: pick.filePath, line: pick.line as number, column });
        continue;
      }
      if (pick?.kind === 'edge' || pick?.kind === 'face') {
        if (pick.kind !== entity) {
          return { error: `${slot} takes ${TAKES[kind]}, not ${pick.kind === 'face' ? 'a face' : 'an edge'}` };
        }
        if (typeof pick.shapeId !== 'string' || pick.shapeId.length === 0
          || !Number.isInteger(pick.index) || (pick.index as number) < 0) {
          return { error: `${slot} holds a ${entity} pick without its {shapeId, index}` };
        }
        inputs.push({ kind: entity, shapeId: pick.shapeId, index: pick.index as number });
        continue;
      }
      return { error: `${slot} holds a pick of an unknown kind` };
    }
    return inputs;
  }

  /** Whether any of the inputs is an edge or a face — what needs synthesis (and, in an edit, a boundary). */
  static picksGeometry(inputs: OperandInput[]): boolean {
    return inputs.some(input => input.kind !== 'statement');
  }

  /** The call sites of the whole objects among the inputs, in pick order. */
  static statements(inputs: OperandInput[]): { filePath: string; line: number; column: number }[] {
    return inputs.flatMap(input => input.kind === 'statement'
      ? [{ filePath: input.filePath, line: input.line, column: input.column }]
      : []);
  }

  /**
   * The picks the inputs come to, in pick order: a whole object as a
   * producer merged into `merger` — typed as a curve (`wire`) or a surface,
   * which it then is for every part that also reads it — and the edges or
   * faces synthesized together by `synthesize`, whose selector parts stand
   * where the first of them was picked. `synthesize` answers the indices of
   * the parts it added, or null once it has refused the request; null is
   * passed on.
   */
  static async resolve(
    inputs: OperandInput[],
    kind: 'curve' | 'surface',
    merger: ProducerMerger,
    synthesize: (picks: Pick[]) => Promise<number[] | null> | number[] | null,
  ): Promise<OperandPick[] | null> {
    const entities: Pick[] = inputs.flatMap(input => input.kind === 'statement'
      ? []
      : [{ shapeId: input.shapeId, sub: { type: input.kind, index: input.index } }]);
    let selectors: OperandPick[] = [];
    if (entities.length > 0) {
      const parts = await synthesize(entities);
      if (parts === null) {
        return null;
      }
      selectors = parts.map(part => ({ kind: 'selector', part }));
    }
    const featureType = kind === 'curve' ? 'wire' : 'surface';
    const picks: OperandPick[] = [];
    let selectorsPlaced = false;
    for (const input of inputs) {
      if (input.kind === 'statement') {
        const producer = merger.merge({
          line: input.line, column: input.column, featureType, nameHint: kind === 'curve' ? 'c' : 's', bind: true,
        });
        // A statement a selector part also reads keeps one entry: taken
        // whole, it is a curve or a surface, and binds as one.
        merger.producers[producer] = { ...merger.producers[producer], featureType, bind: true };
        picks.push({ kind: 'producer', producer });
      } else if (!selectorsPlaced) {
        picks.push(...selectors);
        selectorsPlaced = true;
      }
    }
    return picks;
  }

  /** Whether every path names the same file (normalized). */
  static sameFile(paths: string[]): boolean {
    return new Set(paths.map(path => normalizePath(path))).size <= 1;
  }
}
